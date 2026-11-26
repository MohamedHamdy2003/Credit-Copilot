import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { DecisionStore, DecisionCommand } from '../../../application/src/decisions.js';
import type { AssessmentResult } from '../../../application/src/assessment-record.js';
import {
  approvalAuthorityLimit,
  authorizeApproval,
  requireReviewer,
  type Actor,
} from '../../../domain/src/access.js';
import { invariant } from '../../../domain/src/errors.js';
import {
  addMonths,
  affordability,
  compareMoney,
  formatMoney,
} from '../../../domain/src/calculations.js';
import { parseApplicationForm } from '../../../application/src/application-form.js';
import type { NormalizedDocument } from '../../../contracts/src/documents.js';
import type { ProductId } from '../../../contracts/src/products.js';
import { selectPolicy, selectPricing, type Policy } from '../../../domain/src/policy.js';
import { rejectionClauses } from '../../../domain/src/review-policy.js';
import { loadProductCatalog, type ProductSources } from '../product-catalog.js';
import { buildIssuedOfferDocument, type OfferApprovalRow } from './offer-document.js';
interface RunRow {
  latest_assessment_id?: string | null;
  id: string;
  application_id: string;
  preparer_id: string;
  status: string;
  version: number;
  result: AssessmentResult;
  normalized: NormalizedDocument;
}
export class PostgresDecisionStore implements DecisionStore {
  constructor(
    private readonly db: DataSource,
    private readonly policies: Policy[],
    private catalog?: Record<ProductId, ProductSources>,
  ) {}
  private async productCatalog() {
    this.catalog ??= await loadProductCatalog();
    return this.catalog;
  }
  async read(actor: Actor, runId: string) {
    const rows = (await this.db.query(
      'SELECT r.id,r.application_id,r.status,r.version,r.result,a.preparer_id,o.id AS offer_id FROM cases.assessment_runs r JOIN cases.applications a ON a.id=r.application_id LEFT JOIN cases.offers o ON o.run_id=r.id WHERE r.id=$1',
      [runId],
    )) as RunRow[];
    const row = rows[0];
    invariant(row, 'NotFound', 'Assessment not found', 404);
    invariant(
      actor.role === 'credit_officer' || row.preparer_id === actor.id,
      'Forbidden',
      'Assessment access denied',
      403,
    );
    return row;
  }
  async queue(actor: Actor) {
    requireReviewer(actor);
    return this.db.query(
      "SELECT r.id,r.application_id,a.reference,r.status,r.version,r.result->>'recommendation' AS recommendation,r.result->>'recommendedAmount' AS recommended_amount,r.created_at FROM cases.assessment_runs r JOIN cases.applications a ON a.id=r.application_id WHERE r.status IN ('pending_review','pending_approval','pending_customer_acceptance') AND (a.latest_assessment_id IS NULL OR a.latest_assessment_id=r.id) AND (r.recommendation<>'REFER_TO_HUMAN' OR $1) ORDER BY r.created_at,r.id",
      [['senior', 'head'].includes(actor.tier)],
    );
  }
  async execute(actor: Actor, runId: string, command: DecisionCommand, requestId: string) {
    return this.db.transaction(async (manager) => {
      // Re-read current privileges inside the transaction; request body cannot set role/tier.
      const users = (await manager.query(
        'SELECT id,username,role,tier,can_ingest AS "canIngest" FROM cases.users WHERE id=$1 AND active FOR SHARE',
        [actor.id],
      )) as Actor[];
      invariant(users[0], 'Unauthenticated', 'User disabled or removed', 401);
      actor = users[0];
      if (command.action !== 'customer_response') requireReviewer(actor);
      const rows = (await manager.query(
        'SELECT r.*,a.preparer_id,a.normalized,a.latest_assessment_id FROM cases.assessment_runs r JOIN cases.applications a ON a.id=r.application_id WHERE r.id=$1 FOR UPDATE OF r,a',
        [runId],
      )) as RunRow[];
      const run = rows[0];
      invariant(run, 'NotFound', 'Assessment not found', 404);
      const activeJobs = (await manager.query(
        "SELECT run_id FROM cases.assessment_jobs WHERE application_id=$1 AND status='running' AND created_at>=clock_timestamp()-interval '15 minutes'",
        [run.application_id],
      )) as { run_id: string }[];
      invariant(
        !activeJobs.length,
        'AssessmentInProgress',
        'Wait for the current reassessment before recording a decision',
        409,
      );
      invariant(
        !run.latest_assessment_id || run.latest_assessment_id === run.id,
        'StaleAssessment',
        'A newer assessment exists; review the latest run',
        409,
      );
      invariant(
        run.version === command.expectedVersion,
        'StaleAssessment',
        'Assessment version changed; reload before deciding',
        409,
      );
      const newer = (await manager.query(
        'SELECT id FROM cases.assessment_runs WHERE application_id=$1 AND (created_at,id)>(SELECT created_at,id FROM cases.assessment_runs WHERE id=$2) LIMIT 1',
        [run.application_id, run.id],
      )) as { id: string }[];
      invariant(
        !newer.length,
        'StaleAssessment',
        'A newer assessment exists; review the latest run',
        409,
      );
      const result = run.result;
      const audit = async (event: string, details: unknown) =>
        manager.query(
          'INSERT INTO cases.audit_events(id,run_id,request_id,actor_id,event,details) VALUES($1,$2,$3,$4,$5,$6)',
          [randomUUID(), runId, requestId, actor.id, event, details],
        );
      let next: string;
      if (command.action === 'customer_response') {
        invariant(
          actor.id === run.preparer_id,
          'Forbidden',
          'Only the preparer may record the customer response',
          403,
        );
        invariant(
          run.status === 'pending_customer_acceptance' &&
            result.recommendation === 'OFFER_ALTERNATIVE',
          'InvalidTransition',
          'No alternative is awaiting acceptance',
          409,
        );
        await manager.query(
          'INSERT INTO cases.customer_responses(id,run_id,accepted,recorded_by,comment) VALUES($1,$2,$3,$4,$5)',
          [randomUUID(), runId, command.accepted, actor.id, command.comment],
        );
        next = command.accepted ? 'pending_approval' : 'pending_review';
        await audit('CUSTOMER_RESPONSE_RECORDED', {
          accepted: command.accepted,
          comment: command.comment,
        });
      } else if (command.action === 'approve') {
        invariant(
          run.status === 'pending_approval' || run.status === 'pending_review',
          'InvalidTransition',
          'Assessment is not awaiting approval',
          409,
        );
        invariant(
          !result.fraudReferral && result.evidence.missing.length === 0,
          'UnresolvedReferral',
          'Missing or tampered evidence must be resolved by reassessment',
          409,
        );
        const referred = result.recommendation === 'REFER_TO_HUMAN';
        let amount = result.recommendedAmount ?? null;
        let updatedResult: AssessmentResult | null = null;
        let referredClauses: string[] = [];
        if (referred) {
          const rules = result.results ?? [];
          referredClauses = rules.filter((r) => r.result === 'refer').map((r) => r.rule);
          const reviewableReferral =
            Boolean(result.extraction) &&
            rules.length > 0 &&
            !rules.some((r) => r.result === 'fail') &&
            referredClauses.length > 0 &&
            referredClauses.every((rule) => ['CP-6', 'CP-8'].includes(rule));
          invariant(
            reviewableReferral,
            'UnresolvedReferral',
            'A complete reassessment with verified evidence is required before approval',
            409,
          );
          const form = parseApplicationForm(run.normalized);
          const productSources = (await this.productCatalog())[form.productId];
          const policy = selectPolicy(productSources.policies, form.applicationDate);
          invariant(
            policy.edition === result.policyEdition,
            'ReassessmentRequired',
            'Policy snapshot mismatch',
          );
          const pricing = selectPricing(
            productSources.pricing,
            form.applicationDate,
            form.months,
            form.payrollTransfer,
          );
          const calculation = affordability({
            principal: form.amount,
            annualRatePercent: pricing.annualRatePercent,
            months: form.months,
            income: result.extraction!.fields.income.value,
            obligations: result.extraction!.fields.obligations.value,
            maxDbr: policy.maxDbr,
            productMaximum: productSources.product.maximumAmount,
          });
          invariant(
            calculation.passes,
            'AffordabilityLimitExceeded',
            'Requested amount exceeds policy debt burden limit; reassess for a revised amount',
            409,
          );
          amount = formatMoney(form.amount);
          updatedResult = {
            ...result,
            calculation,
            pricing: {
              annualRatePercent: pricing.annualRatePercent,
              sourceFile: pricing.sourceFile,
              row: pricing.row,
            },
            recommendedAmount: amount,
          };
        } else {
          invariant(
            result.recommendation === 'APPROVE' || result.recommendation === 'OFFER_ALTERNATIVE',
            'UnresolvedReferral',
            'Failed eligibility cannot be silently overridden',
            409,
          );
        }
        invariant(
          amount && compareMoney(amount, '0') > 0,
          'UnresolvedReferral',
          'A complete reassessment with a recommended amount is required',
          409,
        );
        authorizeApproval(actor, run.preparer_id, amount, referred, command.comment);
        if (result.recommendation === 'OFFER_ALTERNATIVE') {
          const responses = (await manager.query(
            'SELECT accepted FROM cases.customer_responses WHERE run_id=$1',
            [runId],
          )) as { accepted: boolean }[];
          invariant(
            responses[0]?.accepted,
            'CustomerAcceptanceRequired',
            'Customer must accept the alternative first',
            409,
          );
        }
        if (updatedResult) {
          await manager.query('UPDATE cases.assessment_runs SET result=$2 WHERE id=$1', [
            runId,
            updatedResult,
          ]);
        }
        const approvalId = randomUUID();
        await manager.query(
          'INSERT INTO cases.approvals(id,run_id,approver_id,decision,comment,amount,assessment_version) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [approvalId, runId, actor.id, 'approved', command.comment, amount, run.version],
        );
        next = 'approved';
        await audit('ASSESSMENT_APPROVED', {
          approvalId,
          approverTier: actor.tier,
          approverAuthorityLimit: approvalAuthorityLimit(actor.tier),
          amount,
          comment: command.comment,
          version: run.version,
          ...(referred ? { referred: true, referredClauses, procedure: 'PM-4' } : {}),
        });
      } else if (command.action === 'reject') {
        requireReviewer(actor);
        invariant(
          actor.id !== run.preparer_id,
          'FourEyesViolation',
          'Preparer cannot decide their own assessment',
          403,
        );
        invariant(
          ['pending_review', 'pending_approval'].includes(run.status),
          'InvalidTransition',
          'Assessment is not awaiting a review decision',
          409,
        );
        if (result.recommendation === 'REFER_TO_HUMAN')
          invariant(
            ['senior', 'head'].includes(actor.tier),
            'Forbidden',
            'Referral decisions require Senior Credit Officer',
            403,
          );
        const customerDeclined = (await manager.query(
          'SELECT accepted FROM cases.customer_responses WHERE run_id=$1',
          [runId],
        )) as { accepted: boolean }[];
        const allowed = rejectionClauses({
          fraudReferral: result.fraudReferral,
          missing: result.evidence.missing,
          results: result.results ?? [],
          customerDeclined: customerDeclined[0]?.accepted === false,
          allowReferredClauses:
            result.recommendation === 'REFER_TO_HUMAN' && ['senior', 'head'].includes(actor.tier),
        });
        invariant(
          allowed.includes(command.clause),
          'InvalidRejectionReason',
          'Rejection must cite a verified failed clause or declined alternative',
        );
        const policy = this.policies.find((p) => p.edition === result.policyEdition);
        invariant(
          policy,
          'PolicyUnavailable',
          'Original policy edition is required for written reasons',
          409,
        );
        const approvalId = randomUUID();
        const sourceFile = command.clause.startsWith('PS-')
          ? (result.productSource ?? 'product-sheet-personal-loan.md')
          : policy.sourceFile;
        const criterion =
          result.results?.find(
            (r) =>
              (r.result === 'fail' || r.result === 'refer') &&
              r.rule.split(' ')[0] === command.clause,
          )?.reason ?? 'Customer declined the maximum eligible alternative under CP-4.1';
        const writtenReason = `${criterion}. Reviewer justification: ${command.comment}`;
        await manager.query(
          'INSERT INTO cases.approvals(id,run_id,approver_id,decision,comment,assessment_version) VALUES($1,$2,$3,$4,$5,$6)',
          [
            approvalId,
            runId,
            actor.id,
            'rejected',
            `${command.clause}: ${writtenReason}`,
            run.version,
          ],
        );
        await manager.query(
          'INSERT INTO cases.rejection_notices(run_id,approval_id,clause,policy_edition,source_file,reason_text) VALUES($1,$2,$3,$4,$5,$6)',
          [runId, approvalId, command.clause, policy.edition, sourceFile, writtenReason],
        );
        next = 'rejected';
        await audit('ASSESSMENT_REJECTED', {
          sourceFile,
          clause: command.clause,
          edition: result.policyEdition,
          comment: command.comment,
        });
      } else {
        requireReviewer(actor);
        invariant(
          run.status === 'approved',
          'InvalidTransition',
          'Only an approved assessment can be issued',
          409,
        );
        const [approval] = (await manager.query(
          "SELECT id,amount::text AS amount,approver_id,created_at,assessment_version FROM cases.approvals WHERE run_id=$1 AND decision='approved'",
          [runId],
        )) as OfferApprovalRow[];
        invariant(
          approval && approval.assessment_version === run.version - 1,
          'ApprovalRequired',
          'Recorded approval for this assessment version is required',
          409,
        );
        authorizeApproval(actor, run.preparer_id, approval.amount, false, command.comment);
        const form = parseApplicationForm(run.normalized);
        invariant(
          command.disbursementDate >= form.applicationDate,
          'InvalidDisbursementDate',
          'Disbursement must not predate the application',
        );
        const policy = selectPolicy(
          this.policies.filter((entry) => (entry.productId ?? 'PL-100') === form.productId),
          form.applicationDate,
        );
        invariant(
          policy.edition === result.policyEdition &&
            (result.productId ?? 'PL-100') === form.productId,
          'ReassessmentRequired',
          'Policy snapshot mismatch',
        );
        invariant(
          addMonths(command.disbursementDate, form.months) <=
            addMonths(form.birthDate, policy.maximumAgeAtMaturity * 12),
          'ReassessmentRequired',
          'Changed maturity date violates age limit',
        );
        const offerId = randomUUID();
        const approvalAudit = (await manager.query(
          "SELECT details FROM cases.audit_events WHERE run_id=$1 AND actor_id=$2 AND event='ASSESSMENT_APPROVED' AND details->>'approvalId'=$3 LIMIT 1",
          [runId, approval.approver_id, approval.id],
        )) as { details: unknown }[];
        const [{ issued_at: issuedAt }] = (await manager.query(
          'SELECT clock_timestamp() AS issued_at',
        )) as [{ issued_at: Date }];
        const document = await buildIssuedOfferDocument({
          offerId,
          runId,
          form,
          result,
          preparerId: run.preparer_id,
          approval,
          approvalAuthority: approvalAudit[0]?.details,
          issuance: {
            issuerId: actor.id,
            issuerTier: actor.tier,
            issuedAt: issuedAt.toISOString(),
          },
          disbursementDate: command.disbursementDate,
        });
        await manager.query(
          'INSERT INTO cases.offers(id,run_id,approval_id,data,created_at) VALUES($1,$2,$3,$4,$5)',
          [
            offerId,
            runId,
            approval.id,
            {
              amount: approval.amount,
              disbursementDate: command.disbursementDate,
              mode: result.mode,
              assumptions: result.evidence.assumptions,
              fullyEvidenceVerified: result.evidence.fullyEvidenceVerified,
              policyEdition: result.policyEdition,
              productId: form.productId,
              document,
            },
            issuedAt,
          ],
        );
        next = 'issued';
        await audit('OFFER_ISSUED', {
          offerId,
          approvalId: approval.id,
          issuerTier: document.issuance.issuerTier,
          disbursementDate: command.disbursementDate,
          comment: command.comment,
        });
      }
      await manager.query(
        'UPDATE cases.assessment_runs SET status=$2,version=version+1 WHERE id=$1',
        [runId, next],
      );
      return { id: runId, status: next, version: run.version + 1 };
    });
  }
}
