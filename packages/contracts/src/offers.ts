import { z } from 'zod';
import { productIds } from './products.js';

const money = z.string().regex(/^\d+\.\d{2}$/);
const percent = z.string().regex(/^\d+(?:\.\d+)?$/);
const tier = z.enum(['credit', 'senior', 'head']);
const sourceFile = z
  .string()
  .regex(/^[a-zA-Z0-9 ._-]+\.(csv|md|pdf)$/)
  .max(100);

export const issuedOfferDocumentSchema = z.object({
  version: z.literal(1),
  offerId: z.uuid(),
  runId: z.uuid(),
  applicationReference: z.string().regex(/^(?:APP|AUTO)-\d{3}$/),
  productId: z.enum(productIds),
  policyEdition: z.string().min(1).max(32),
  mode: z.enum(['strict', 'demo']),
  fullyEvidenceVerified: z.boolean(),
  principal: money,
  annualRatePercent: percent,
  months: z.number().int().positive(),
  disbursementDate: z.iso.date(),
  administrativeFeePercent: percent,
  earlySettlementFeePercent: percent,
  lateFee: money,
  schedule: z.object({
    installment: money,
    administrativeFee: money,
    netDisbursement: money,
    totalInterest: money,
    totalRepayment: money,
    rows: z
      .array(
        z.object({
          number: z.number().int().positive(),
          dueDate: z.iso.date(),
          installment: money,
          principal: money,
          interest: money,
          balance: money,
        }),
      )
      .min(1)
      .max(1200),
  }),
  pricing: z.object({
    sourceFile,
    row: z.number().int().min(2),
    documentId: z.string().max(40).optional(),
    version: z.string().max(24).optional(),
  }),
  conditions: z
    .array(
      z.object({
        description: z.string().min(1).max(200),
        sourceFile,
        clause: z.string().regex(/^(?:PS|CP)-\d+(?:\.\d+)?$/),
        documentId: z.string().max(40).optional(),
        version: z.string().max(24).optional(),
      }),
    )
    .min(1)
    .max(12),
  approval: z.object({
    id: z.uuid(),
    preparerId: z.uuid(),
    approverId: z.uuid(),
    approvedAt: z.iso.datetime(),
    approverTier: tier.optional(),
    approverAuthorityLimit: money.optional(),
  }),
  issuance: z.object({
    issuerId: z.uuid(),
    issuedAt: z.iso.datetime(),
    issuerTier: tier.optional(),
  }),
});

export type IssuedOfferDocument = z.infer<typeof issuedOfferDocumentSchema>;
