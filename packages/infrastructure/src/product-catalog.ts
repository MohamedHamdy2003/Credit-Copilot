import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProductId } from '../../contracts/src/products.js';
import { invariant } from '../../domain/src/errors.js';
import type { Policy, PricingRow, Product } from '../../domain/src/policy.js';
import type { ManifestEntry } from './knowledge/ingestion.js';
import { ParserRegistry } from './parsers/registry.js';
import { extractPricing } from './parsers/pricing.js';

export interface ProductSources {
  product: Product;
  policies: Policy[];
  pricing: PricingRow[];
}

const catalogFiles = {
  'PL-100': {
    product: 'personal-loan.json',
    policies: 'policies.json',
    pricing: 'pricing-table.csv',
  },
  'AL-200': {
    product: 'auto-loan.json',
    policies: 'auto-policies.json',
    pricing: 'synthetic-auto-pricing.csv',
  },
} satisfies Record<ProductId, { product: string; policies: string; pricing: string }>;

export async function loadProductCatalog(
  parser = new ParserRegistry(),
): Promise<Record<ProductId, ProductSources>> {
  const manifest = JSON.parse(
    await readFile('data/config/corpus-manifest.json', 'utf8'),
  ) as ManifestEntry[];

  async function load(id: ProductId): Promise<ProductSources> {
    const files = catalogFiles[id];
    const product = JSON.parse(await readFile(`data/config/${files.product}`, 'utf8')) as Product;
    const policies = JSON.parse(
      await readFile(`data/config/${files.policies}`, 'utf8'),
    ) as Policy[];
    const trustedSources = manifest.filter((entry) => entry.product === id);
    invariant(
      product.id === id &&
        trustedSources.some(
          (entry) => entry.kind === 'product' && entry.filename === product.sourceFile,
        ),
      'InvalidProductSources',
      'Product source must match the reviewed product catalog',
    );
    invariant(
      policies.length > 0 &&
        policies.every(
          (policy) =>
            (policy.productId ?? 'PL-100') === id &&
            trustedSources.some(
              (entry) =>
                entry.kind === 'policy' &&
                entry.filename === policy.sourceFile &&
                entry.edition === policy.edition &&
                entry.effectiveFrom === policy.effectiveFrom &&
                entry.effectiveTo === policy.effectiveTo,
            ),
        ),
      'InvalidProductSources',
      'Policy dates and editions must match reviewed sources for this product',
    );
    const pricingSource = trustedSources.find(
      (entry) => entry.kind === 'pricing' && entry.filename === files.pricing,
    );
    const bytes = await readFile(`data/corpus/policy/${files.pricing}`);
    invariant(
      pricingSource && pricingSource.sha256 === createHash('sha256').update(bytes).digest('hex'),
      'InvalidProductSources',
      'Pricing table must match the reviewed source for this product',
    );
    const pricing = extractPricing(await parser.extract(files.pricing, bytes));
    invariant(
      pricing.every(
        (row) => row.documentId === pricingSource.id && row.version === pricingSource.edition,
      ),
      'InvalidProductSources',
      'Pricing rows must identify the reviewed pricing document',
    );
    return { product, policies, pricing };
  }

  const [personal, auto] = await Promise.all([load('PL-100'), load('AL-200')]);
  return { 'PL-100': personal, 'AL-200': auto };
}

const fixtureManifestSchema = z
  .array(
    z
      .object({
        reference: z.string().regex(/^(?:APP|AUTO)-\d{3}$/),
        filename: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  )
  .min(1);

export async function loadAssessmentFixtures() {
  const manifest = fixtureManifestSchema.parse(
    JSON.parse(await readFile('data/config/assessment-fixtures.json', 'utf8')),
  );
  invariant(
    new Set(manifest.map((entry) => entry.reference)).size === manifest.length,
    'InvalidAssessmentFixtures',
    'Assessment fixture references must be unique',
  );
  return Promise.all(
    manifest.map(async ({ reference, filename, sha256 }) => {
      invariant(
        filename === `${reference}.pdf`,
        'InvalidAssessmentFixtures',
        'Assessment fixture filename must match its reviewed reference',
      );
      const bytes = await readFile(`data/corpus/evidence/${filename}`);
      const hash = createHash('sha256').update(bytes).digest('hex');
      invariant(hash === sha256, 'InvalidAssessmentFixtures', 'Assessment fixture hash mismatch');
      return { reference, filename, bytes, hash };
    }),
  );
}
