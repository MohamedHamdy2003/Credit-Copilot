import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DataSource } from 'typeorm';
import type { INestApplication } from '@nestjs/common';
import { createApi } from '../../apps/api/src/app.js';
import { AuthService } from '../../packages/application/src/auth.js';
import { DecisionService } from '../../packages/application/src/decisions.js';
import { answerPolicyQuestion } from '../../packages/application/src/questions.js';
import { answerCalculationQuestion } from '../../packages/application/src/calculation-question.js';
import { parseApplicationForm } from '../../packages/application/src/application-form.js';
import { sanitizeEvidence } from '../../packages/application/src/extraction.js';
import { deriveEvidenceFacts } from '../../packages/application/src/evidence-facts.js';
import {
  assertion,
  numericAssertions,
  type EvaluationCase,
  type EvaluationResult,
} from '../../packages/application/src/evaluation.js';
import type { AssessmentResult } from '../../packages/application/src/assessment-record.js';
import type { Policy, Product, PricingRow } from '../../packages/domain/src/policy.js';
import type { Actor } from '../../packages/domain/src/access.js';
import type { NormalizedDocument } from '../../packages/contracts/src/documents.js';
import type { Config } from '../../packages/contracts/src/config.js';
import { invariant, DomainError } from '../../packages/domain/src/errors.js';
import { selectPolicy, selectPricing } from '../../packages/domain/src/policy.js';
import { compareMoney } from '../../packages/domain/src/calculations.js';
import { assessRules } from '../../packages/domain/src/rules.js';
import { ParserRegistry } from '../../packages/infrastructure/src/parsers/registry.js';
import { extractPricing } from '../../packages/infrastructure/src/parsers/pricing.js';
import { RetrievalService } from '../../packages/infrastructure/src/knowledge/retrieval.js';
import { PostgresAssessmentClauses } from '../../packages/infrastructure/src/knowledge/assessment-clauses.js';
import { PostgresAssessmentRepository } from '../../packages/infrastructure/src/db/assessment-repository.js';
import { PostgresDecisionStore } from '../../packages/infrastructure/src/db/decision-store.js';
import { PostgresApplicationStore } from '../../packages/infrastructure/src/db/application-store.js';
import { PostgresAuthStore } from '../../packages/infrastructure/src/auth/store.js';
import { ScryptCredentials } from '../../packages/infrastructure/src/auth/passwords.js';
import { createDocumentAssessmentWorkflow } from '../../packages/infrastructure/src/workflows/document-assessment.js';
import type { PolicySearch } from '../../packages/application/src/questions.js';
import { EvaluationMeter } from '../../packages/infrastructure/src/evaluation-meter.js';
import { assessmentAgents } from '../../packages/infrastructure/src/workflows/assessment-agents.js';
import { ASSESSMENT_AGENT_TOOLS } from '../../packages/application/src/assessment-agents.js';

export class CoreEvaluation {
  private readonly parser = new ParserRegistry();
  private policies!: Policy[];
  private product!: Product;
  private pricing!: PricingRow[];
  private questionPrompt = '';
  private extractionPrompt = '';
  private api!: INestApplication;
  private base = '';
  private password = randomUUID() + randomUUID();
  private hash = '';
  private constructor(
    private readonly db: DataSource,
    private readonly meter: EvaluationMeter,
    private readonly config: Config,
    private readonly search: PolicySearch,
  ) {}
  static async create(
    db: DataSource,
    meter: EvaluationMeter,
    config: Config,
    search?: PolicySearch,
  ) {
    const r = new CoreEvaluation(
      db,
      meter,
      config,
      search ?? new RetrievalService(db, meter, config.RETRIEVAL_STRATEGY, config),
    );
    r.policies = JSON.parse(await readFile('data/config/policies.json', 'utf8'));
    r.product = JSON.parse(await readFile('data/config/personal-loan.json', 'utf8'));
    r.pricing = extractPricing(
      await r.parser.extract(
        'pricing-table.csv',
        await readFile('data/corpus/policy/pricing-table.csv'),
      ),
    );
    r.questionPrompt = await readFile('prompts/questions.txt', 'utf8');
    r.extractionPrompt = await readFile('prompts/extraction.txt', 'utf8');
    r.hash = await new ScryptCredentials().hash(r.password);
    r.api = await createApi({
      auth: new AuthService(new PostgresAuthStore(db), new ScryptCredentials(), 1),
      decisions: new DecisionService(new PostgresDecisionStore(db, r.policies)),
      webOrigin: config.WEB_ORIGIN,
      secureCookies: false,
      sessionHours: 1,
    });
    await r.api.listen(0, '127.0.0.1');
    r.base = await r.api.getUrl();
    return r;
  }
  async close() {
    if (this.api) await this.api.close();
  }
  private async actor(tier: Actor['tier']) {
    const actor: Actor = {
      id: randomUUID(),
      username: `evaluation-${randomUUID()}`,
      role: tier === 'none' ? 'loan_officer' : 'credit_officer',
      tier,
      canIngest: false,
    };
    await this.db.query(
      'INSERT INTO cases.users(id,username,password_hash,role,tier) VALUES($1,$2,$3,$4,$5)',
      [actor.id, actor.username, this.hash, actor.role, tier],
    );
    return actor;
  }
  private async document(reference: string) {
    return this.parser.extract(
      `${reference}.pdf`,
      await readFile(`data/corpus/evidence/${reference}.pdf`),
    );
  }
  private async assess(
    reference: string,
    mode: 'strict' | 'demo',
    document?: NormalizedDocument,
    existing?: { id: string; actor: Actor },
  ) {
    const actor = existing?.actor ?? (await this.actor('none')),
      doc = document ?? (await this.document(reference));
    const app =
      existing ??
      (await new PostgresApplicationStore(this.db).register(
        actor,
        doc,
        await readFile(`data/corpus/evidence/${reference}.pdf`),
      ));
    const runId = randomUUID(),
      requestId = randomUUID();
    const workflow = createDocumentAssessmentWorkflow({
      provider: this.meter,
      agents: assessmentAgents(this.config.ASSESSMENT_ORCHESTRATION),
      prompt: this.extractionPrompt,
      policies: this.policies,
      product: this.product,
      pricing: this.pricing,
      settings: { allowDemo: true, defaultMode: 'strict' },
      clauses: new PostgresAssessmentClauses(this.db),
      persistence: {
        runId,
        applicationId: app.id,
        requestId,
        repository: new PostgresAssessmentRepository(this.db),
      },
    });
    const output = await (
      await workflow.createRun()
    ).start({
      inputData: {
        document: doc,
        actorId: actor.id,
        synthetic: true,
        requestedMode: mode,
        at: new Date().toISOString(),
      },
    });
    invariant(output.status === 'success', 'EvaluationWorkflowFailed', 'Workflow did not complete');
    return { runId, applicationId: app.id, actor, result: output.result.result!, doc };
  }
  private async auditChecks(runId: string, result: AssessmentResult) {
    const events = (await this.db.query(
      'SELECT event,details FROM cases.audit_events WHERE run_id=$1',
      [runId],
    )) as { event: string; details: Record<string, unknown> }[];
    const toolEvents = events.filter((event) => event.event === 'ASSESSMENT_AGENT_TOOL');
    const expectedToolCalls = result.extraction
      ? Object.entries(ASSESSMENT_AGENT_TOOLS).map(([agent, tool]) => ({
          agent,
          tool,
          status: 'executed',
        }))
      : [];
    return [
      ...(this.config.ASSESSMENT_ORCHESTRATION === 'agents'
        ? [
            assertion(
              'bounded_agent_tools_executed',
              'audit',
              expectedToolCalls,
              result.agentToolCalls ?? [],
            ),
            assertion(
              'agent_tools_persisted',
              'audit',
              [...(result.agentToolCalls ?? [])].sort((a, b) => a.agent.localeCompare(b.agent)),
              toolEvents
                .map(({ details }) => ({
                  agent: details.agent,
                  tool: details.tool,
                  status: details.status,
                  reason: details.reason,
                }))
                .sort((a, b) => String(a.agent).localeCompare(String(b.agent))),
            ),
          ]
        : []),
      assertion(
        'eight_recorded_stages',
        'audit',
        8,
        events.filter((e) => e.event === 'ASSESSMENT_STEP').length,
      ),
      assertion(
        'protected_removal_logged',
        'audit',
        true,
        events.some((e) => e.event === 'PROTECTED_ATTRIBUTES_REMOVED'),
      ),
      assertion('policy_edition_recorded', 'audit', 'CP-2025', result.policyEdition),
      assertion('retrieved_ids_recorded', 'audit', true, Array.isArray(result.retrievedChunkIds)),
      assertion('usage_recorded_or_no_call', 'audit', true, Array.isArray(result.usageRecords)),
      assertion('memo_prepared', 'audit', true, Boolean(result.memo)),
      assertion(
        'persisted_chunk_ids',
        'audit',
        result.retrievedChunkIds,
        events.find((e) => e.event === 'POLICY_EVIDENCE_RETRIEVED')?.details.chunkIds,
      ),
      assertion(
        'persisted_policy_edition',
        'audit',
        result.policyEdition,
        events.find((e) => e.event === 'ASSESSMENT_RECORDED')?.details.policyEdition,
      ),
    ];
  }
  async strictChecks() {
    const results = [];
    for (const ref of ['APP-001', 'APP-002', 'APP-003', 'APP-004', 'APP-005']) {
      const r = await this.assess(ref, 'strict');
      results.push({
        reference: ref,
        recommendation: r.result.recommendation,
        policyEdition: r.result.policyEdition,
        missing: r.result.evidence.missing,
        fraud: r.result.fraudReferral,
        passed:
          r.result.recommendation === 'REFER_TO_HUMAN' &&
          r.result.mode === 'strict' &&
          !r.result.evidence.fullyEvidenceVerified &&
          r.result.policyEdition === 'CP-2025' &&
          (r.result.agentToolCalls?.length ?? 0) === 0 &&
          (r.result.usageRecords?.length ?? 0) === 0,
      });
    }
    return results;
  }
  async run(c: EvaluationCase): Promise<EvaluationResult> {
    const started = performance.now(),
      from = this.meter.events.length;
    const r: EvaluationResult = {
      id: c.id,
      kind: c.kind,
      expectedSummary: c.expectedSummary,
      assertions: [],
      passed: false,
      latencyMs: 0,
      metrics: this.meter.metrics(from),
      observed: null,
    };
    if (c.kind === 'question')
      r.retrieval = {
        hitAt5: c.expectedRefusal ? null : false,
        gold: c.gold!,
        critical: c.criticalGold!,
        candidateKeys: [],
        citationKeys: [],
      };
    if (c.kind === 'question') r.refusal = { expected: c.expectedRefusal!, actual: null };
    try {
      if (c.kind === 'question') {
        const before = await this.db.query(
          'SELECT (SELECT count(*) FROM cases.approvals)::int AS approvals,(SELECT count(*) FROM cases.offers)::int AS offers',
        );
        const { hits, rewrite } =
          this.search instanceof RetrievalService
            ? await this.search.searchWithTrace(c.question!, c.date!)
            : { hits: await this.search.search(c.question!, c.date!), rewrite: undefined };
        const keys = hits.map((h) => `${h.chunk.documentId}:${h.chunk.section}`);
        r.retrieval = {
          hitAt5: c.expectedRefusal ? null : c.gold!.some((g) => keys.includes(g)),
          gold: c.gold!,
          critical: c.criticalGold!,
          candidateKeys: keys,
          citationKeys: [],
        };
        const observed = {
          candidates: hits.map((h) => ({
            key: `${h.chunk.documentId}:${h.chunk.section}`,
            id: h.chunk.id,
            similarity: h.similarity,
            ...('ranking' in h ? { ranking: h.ranking } : {}),
          })),
          retrievalThreshold: this.config.RETRIEVAL_MIN_SIMILARITY,
          ...(rewrite ? { rewrite } : {}),
        };
        r.observed = observed;
        const answer = await answerPolicyQuestion(
          { question: c.question!, asOfDate: c.date! },
          {
            provider: this.meter,
            prompt: this.questionPrompt,
            minimumSimilarity: this.config.RETRIEVAL_MIN_SIMILARITY,
            search: { search: async () => hits, related: this.search.related?.bind(this.search) },
          },
        );
        const citations = answer.citations.map((q) => `${q.documentId}:${q.section}`);
        r.retrieval.citationKeys = citations;
        r.refusal = { expected: c.expectedRefusal!, actual: answer.refused };
        r.assertions.push(assertion('refusal', 'behavior', c.expectedRefusal, answer.refused));
        for (const pattern of c.expectedPatterns!)
          r.assertions.push(
            assertion(
              `answer_${pattern}`,
              'behavior',
              true,
              new RegExp(pattern, 'i').test(answer.answer),
            ),
          );
        if (c.expectedResolutionPattern)
          r.assertions.push(
            assertion(
              'explains_which_source_governs',
              'behavior',
              true,
              'resolution' in answer &&
                typeof answer.resolution === 'string' &&
                new RegExp(c.expectedResolutionPattern, 'i').test(answer.resolution),
            ),
          );
        for (const gold of c.criticalGold!)
          r.assertions.push(
            assertion(`critical_evidence_${gold}`, 'coverage', true, citations.includes(gold)),
          );
        if (['Q01', 'Q02'].includes(c.id))
          r.assertions.push(
            assertion(
              'income_criterion_code_only',
              'behavior',
              c.id === 'Q01',
              compareMoney('9000', selectPolicy(this.policies, c.date!).minimumIncome) >= 0,
            ),
          );
        if (c.id === 'Q10')
          r.assertions.push(
            assertion(
              'approval_action_rejected',
              'security',
              true,
              'requestedActionRejected' in answer && answer.requestedActionRejected,
            ),
          );
        if (c.id === 'Q10')
          r.assertions.push(
            assertion(
              'no_approval_state_mutation',
              'security',
              before,
              await this.db.query(
                'SELECT (SELECT count(*) FROM cases.approvals)::int AS approvals,(SELECT count(*) FROM cases.offers)::int AS offers',
              ),
            ),
          );
        r.observed = { ...observed, answer };
      } else if (c.kind === 'calculation') {
        const output = answerCalculationQuestion(
          {
            principal: c.principal,
            income: c.income,
            obligations: c.obligations,
            months: c.months,
            date: c.date,
          },
          { policies: this.policies, product: this.product, pricing: this.pricing },
        );
        r.assertions.push(
          ...numericAssertions(c, output.calculation),
          assertion('policy_edition', 'behavior', c.expectedEdition, output.policyEdition),
          assertion('rate_from_csv', 'behavior', '24.00', output.annualRatePercent),
        );
        r.observed = output;
      } else if (c.kind === 'assessment') {
        const run = await this.assess(c.reference!, 'demo'),
          result = run.result;
        r.assertions.push(
          assertion('safe_recommendation', 'behavior', 'REFER_TO_HUMAN', result.recommendation),
          assertion('affordability_skipped', 'behavior', null, result.calculation),
          ...(await this.auditChecks(run.runId, result)),
        );
        if (c.id === 'Q11') {
          const clean = sanitizeEvidence(run.doc),
            salary = clean.lines.filter(
              (l) => l.section === 'salary' && l.text.startsWith('Net monthly income '),
            );
          const events = await this.db.query(
            "SELECT event FROM cases.audit_events WHERE run_id=$1 AND event='FRAUD_UNIT_REFERRAL'",
            [run.runId],
          );
          r.assertions.push(
            assertion(
              'real_salary_18000',
              'security',
              ['Net monthly income 18,000.00'],
              salary.map((l) => l.text),
            ),
            assertion('fraud_referral', 'security', true, result.fraudReferral),
            assertion('fraud_audit', 'audit', 1, events.length),
            assertion(
              'zero_generation_for_tampering',
              'security',
              0,
              this.meter.metrics(from).generationCalls,
            ),
          );
          r.observed = {
            reference: c.reference,
            result,
            sanitizedSalary: salary,
            runId: run.runId,
          };
        } else {
          invariant(
            result.extraction,
            'EvaluationExtractionMissing',
            'No verified extraction available',
          );
          const form = parseApplicationForm(run.doc),
            derived = deriveEvidenceFacts(run.doc),
            x = result.extraction.fields;
          const rules = assessRules(
            {
              ...derived.facts,
              applicationDate: form.applicationDate,
              birthDate: form.birthDate,
              amount: form.amount,
              months: form.months,
              income: x.income.value,
              obligations: x.obligations.value,
              employmentStart: x.employmentStart.value,
              bureauScore: x.bureauScore.value,
            },
            selectPolicy(this.policies, form.applicationDate),
            this.product,
            selectPricing(this.pricing, form.applicationDate, form.months, form.payrollTransfer),
          );
          r.assertions.push(
            assertion('probation_not_assumed', 'security', null, derived.facts.confirmed),
          );
          if (c.id === 'Q06') {
            const financial = answerCalculationQuestion(
              {
                principal: form.amount,
                income: x.income.value,
                obligations: x.obligations.value,
                months: form.months,
                date: form.applicationDate,
                payroll: form.payrollTransfer,
              },
              { policies: this.policies, product: this.product, pricing: this.pricing },
            );
            r.assertions.push(...numericAssertions(c, financial.calculation));
            r.observed = {
              runId: run.runId,
              result,
              financialOnly: financial,
              note: 'Financial-only output is not a whole-application offer or recommendation.',
            };
          } else {
            const rule = c.id === 'Q12' ? 'CP-3.5' : 'CP-6';
            r.assertions.push(
              assertion(
                `source_rule_${rule}`,
                'behavior',
                c.id === 'Q12' ? 'fail' : 'refer',
                rules.results.find((v) => v.rule === rule)?.result,
              ),
            );
            if (c.id === 'Q13')
              r.assertions.push(
                assertion('source_bureau_score', 'security', 580, x.bureauScore.value),
              );
            r.observed = { runId: run.runId, result, independentRules: rules.results };
          }
        }
      } else if (c.kind === 'authority') {
        const run = await this.assess('APP-001', 'demo');
        r.assertions.push(...(await this.auditChecks(run.runId, run.result)));
        const credit = await this.actor('credit'),
          senior = await this.actor('senior');
        const login = async (actor: Actor) => {
          const response = await fetch(`${this.base}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: actor.username, password: this.password }),
          });
          invariant(response.ok, 'EvaluationLoginFailed', 'Evaluation login failed');
          const body = (await response.json()) as { csrfToken: string };
          return {
            cookie: response.headers.get('set-cookie')!.split(';')[0]!,
            csrf: body.csrfToken,
          };
        };
        const post = async (
          session: { cookie: string; csrf: string },
          action: string,
          version: number,
        ) =>
          fetch(`${this.base}/api/v1/assessments/${run.runId}/decisions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: session.cookie,
              'x-csrf-token': session.csrf,
            },
            body: JSON.stringify({
              action,
              expectedVersion: version,
              comment: 'Synthetic evaluation: independent review of evidence and Demo assumption',
              ...(action === 'issue' ? { disbursementDate: '2025-04-03' } : {}),
            }),
          });
        const cs = await login(credit),
          ss = await login(senior);
        const early = await post(ss, 'issue', 1),
          denial = await post(cs, 'approve', 1);
        const error = (await denial.json()) as { error: { code: string } };
        const pending = await this.db.query(
          'SELECT status,version FROM cases.assessment_runs WHERE id=$1',
          [run.runId],
        );
        r.assertions.push(
          assertion('issuance_requires_approval', 'security', 409, early.status),
          assertion('credit_limit_denied', 'security', 403, denial.status),
          assertion(
            'named_authority_error',
            'security',
            'AuthorityLimitExceeded',
            error.error.code,
          ),
          assertion(
            'pending_after_denial',
            'security',
            [{ status: 'pending_approval', version: 1 }],
            pending,
          ),
          assertion(
            'recommended_amount',
            'security',
            true,
            compareMoney(run.result.recommendedAmount ?? '0', '300000') === 0,
          ),
        );
        const approved = await post(ss, 'approve', 1),
          issued = await post(ss, 'issue', 2);
        const offers = (await this.db.query('SELECT data FROM cases.offers WHERE run_id=$1', [
          run.runId,
        ])) as { data: { fullyEvidenceVerified: boolean; mode: string } }[];
        r.assertions.push(
          assertion('independent_senior_approval', 'security', 201, approved.status),
          assertion('issued_after_approval', 'security', 201, issued.status),
          assertion(
            'demo_offer_not_verified',
            'security',
            false,
            offers[0]?.data.fullyEvidenceVerified,
          ),
        );
        r.observed = {
          runId: run.runId,
          pending,
          approvalStatus: approved.status,
          issueStatus: issued.status,
          offers: offers.map((o) => o.data),
        };
      } else {
        const first = await this.assess('APP-001', 'demo'),
          before = this.meter.events
            .slice(from)
            .filter((e) => e.kind === 'generation')
            .map((e) => e.inputHash);
        const changed = {
          ...first.doc,
          blocks: first.doc.blocks.map((b) => ({
            ...b,
            text: b.text
              .replace('Gender Male', 'Gender Female')
              .replace('Marital status Married', 'Marital status Single')
              .replace('Religion Muslim', 'Religion Christian')
              .replace('Nationality Egyptian', 'Nationality Other'),
          })),
        };
        const middle = this.meter.events.length;
        const second = await this.assess('APP-001', 'demo', changed, {
          id: first.applicationId,
          actor: first.actor,
        });
        const after = this.meter.events
          .slice(middle)
          .filter((e) => e.kind === 'generation')
          .map((e) => e.inputHash);
        r.assertions.push(
          assertion(
            'four_fields_changed_only',
            'security',
            false,
            JSON.stringify(changed.blocks) === JSON.stringify(first.doc.blocks),
          ),
          assertion('same_provider_input', 'security', before, after),
          assertion(
            'same_recommendation',
            'security',
            first.result.recommendation,
            second.result.recommendation,
          ),
          assertion(
            'same_calculations',
            'security',
            first.result.calculation,
            second.result.calculation,
          ),
          assertion('same_rules', 'security', first.result.results, second.result.results),
          assertion('same_memo', 'security', first.result.memo, second.result.memo),
          ...(await this.auditChecks(first.runId, first.result)),
          ...(await this.auditChecks(second.runId, second.result)),
        );
        r.observed = {
          firstRun: first.runId,
          secondRun: second.runId,
          providerInputHashes: [before, after],
          recommendation: first.result.recommendation,
          calculation: first.result.calculation,
          memo: first.result.memo,
          removedFields: second.result.removedFields,
          note: 'Counterfactual changes normalized protected form values only; original PDF is retained, no new customer document is fabricated or indexed.',
        };
      }
    } catch (error) {
      r.error =
        error instanceof DomainError
          ? error.code
          : error instanceof Error
            ? error.name
            : 'UnknownEvaluationFailure';
      r.assertions.push(assertion('completed_without_error', 'behavior', true, false));
      if (c.expectedEmi && !r.assertions.some((a) => a.name === 'monthlyInstallment'))
        r.assertions.push(...numericAssertions(c));
    }
    r.latencyMs = Math.round(performance.now() - started);
    r.metrics = this.meter.metrics(from);
    r.passed = !r.error && r.assertions.every((a) => a.passed);
    return r;
  }
}
