import { Decimal } from 'decimal.js';
import type { Config } from '../../../contracts/src/config.js';
import type { PriceSnapshot, UsageEvent } from '../../../contracts/src/usage.js';
import type { ProviderAttempt } from './attempt-meter.js';

const D = Decimal.clone({ precision: 32 });
const publishedRates = {
  'gemini-3.5-flash-lite': {
    kind: 'generation',
    input: '0.30',
    output: '2.50',
    anchor: 'gemini-3.5-flash-lite',
  },
  'gemini-embedding-001': {
    kind: 'embedding',
    input: '0.15',
    output: '0.00',
    anchor: 'gemini-embedding',
  },
} as const;

function priceSnapshot(attempt: ProviderAttempt): PriceSnapshot | null {
  if (attempt.provider !== 'gemini' || !Object.hasOwn(publishedRates, attempt.model)) return null;
  const rate = publishedRates[attempt.model as keyof typeof publishedRates];
  if (rate.kind !== (attempt.kind === 'generation' ? 'generation' : 'embedding')) return null;
  return {
    currency: 'USD',
    capturedOn: '2026-11-21',
    source: `https://aistudio.google.com/docs/pricing#${rate.anchor}`,
    inputUsdPerMillion: rate.input,
    outputUsdPerMillion: rate.output,
  };
}

export function priceAttempt(
  attempt: ProviderAttempt,
  billingTier: Config['GEMINI_BILLING_TIER'],
): Pick<UsageEvent, 'price' | 'estimatedUsd' | 'actualUsd' | 'chargeBasis'> {
  const price = priceSnapshot(attempt);
  const estimatedUsd =
    price && attempt.inputTokens !== null && attempt.outputTokens !== null
      ? new D(attempt.inputTokens)
          .mul(price.inputUsdPerMillion)
          .plus(new D(attempt.outputTokens).mul(price.outputUsdPerMillion))
          .div(1000000)
          .toFixed(8)
      : null;
  const chargeBasis =
    attempt.provider === 'ollama'
      ? 'local'
      : price && billingTier === 'confirmed_free'
        ? 'confirmed_free_tier'
        : 'unknown';
  return {
    price,
    estimatedUsd,
    chargeBasis,
    actualUsd: chargeBasis === 'unknown' ? null : '0.00000000',
  };
}
