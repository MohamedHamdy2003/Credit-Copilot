import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ollamaSettingsSchema } from '../packages/contracts/src/config.js';
import { DomainError, invariant } from '../packages/domain/src/errors.js';
import type { Policy, Product } from '../packages/domain/src/policy.js';
import type { AssessmentRecord } from '../packages/application/src/assessment-record.js';
import { answerPolicyQuestion } from '../packages/application/src/questions.js';
import { OllamaAdapter } from '../packages/infrastructure/src/llm/ollama.js';
import { GenerationFallback } from '../packages/infrastructure/src/llm/provider.js';
import type { ManifestEntry } from '../packages/infrastructure/src/knowledge/ingestion.js';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import { chunkDocument } from '../packages/infrastructure/src/parsers/chunker.js';
import { extractPricing } from '../packages/infrastructure/src/parsers/pricing.js';
import { createDocumentAssessmentWorkflow } from '../packages/infrastructure/src/workflows/document-assessment.js';

const settings = ollamaSettingsSchema.parse(process.env);
const primary = 'simulated-gemini';
const outage = async () => {
  throw new DomainError('ProviderUnavailable', 'Injected primary outage', 503, {
    model: primary,
    retryable: true,
  });
};
const provider = new GenerationFallback(
  {
    model: 'simulated-gemini-embedding',
    dimensions: 768,
    embed: outage,
    completeStructured: outage,
  },
  new OllamaAdapter(settings),
);
const report = {
  at: new Date().toISOString(),
  model: settings.OLLAMA_MODEL,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeDirty:
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  scope:
    'real local Ollama, injected primary outage, trusted fixture clauses and in-memory assessment persistence',
  results: [] as { name: string; passed: boolean; latencyMs: number; details: unknown }[],
};
async function measure(name: string, check: () => Promise<unknown>) {
  const start = performance.now();
  try {
    const details = await check();
    report.results.push({
      name,
      passed: true,
      latencyMs: Math.round(performance.now() - start),
      details,
    });
  } catch (error) {
    report.results.push({
      name,
      passed: false,
      latencyMs: Math.round(performance.now() - start),
      details: error instanceof DomainError ? error.code : 'SmokeCheckFailed',
    });
  }
}

const parser = new ParserRegistry();
const manifest = JSON.parse(
  await readFile('data/config/corpus-manifest.json', 'utf8'),
) as ManifestEntry[];
const policy = manifest.find((entry) => entry.id === 'CP-2025')!;
const policyDocument = await parser.extract(
  policy.filename,
  await readFile(`data/corpus/policy/${policy.filename}`),
);
invariant(
  policy.sha256 === policyDocument.hash,
  'UntrustedPolicyDocument',
  'Policy hash does not match the manifest',
);
const clauses = chunkDocument(policyDocument, policy);
const ollamaModel = `ollama:${settings.OLLAMA_MODEL}`;

await measure('verified_extraction_and_code_memo', async () => {
  const reference = 'APP-001';
  const document = await parser.extract(
    `${reference}.pdf`,
    await readFile(`data/corpus/evidence/${reference}.pdf`),
  );
  const records: AssessmentRecord[] = [];
  const workflow = createDocumentAssessmentWorkflow({
    provider,
    prompt: await readFile('prompts/extraction.txt', 'utf8'),
    policies: JSON.parse(await readFile('data/config/policies.json', 'utf8')) as Policy[],
    product: JSON.parse(await readFile('data/config/personal-loan.json', 'utf8')) as Product,
    pricing: extractPricing(
      await parser.extract(
        'pricing-table.csv',
        await readFile('data/corpus/policy/pricing-table.csv'),
      ),
    ),
    settings: { allowDemo: true },
    clauses: { loadRequired: async () => clauses },
    persistence: {
      runId: randomUUID(),
      applicationId: randomUUID(),
      requestId: randomUUID(),
      repository: {
        save: async (record) => {
          records.push(record);
        },
      },
    },
  });
  const run = await workflow.createRun();
  await run.start({
    inputData: {
      document,
      actorId: randomUUID(),
      at: report.at,
      requestedMode: 'demo',
      synthetic: true,
    },
  });
  const result = records[0]?.result;
  invariant(result, 'SmokeAssessmentFailed', 'No assessment outcome was recorded');
  invariant(
    result.extraction?.model === ollamaModel && result.usageRecords?.[1]?.fallbackFrom === primary,
    result.reason ?? 'SmokeAttributionFailed',
    'Expected a source-verified extraction using Ollama',
  );
  invariant(
    result.status === 'pending_approval' &&
      result.calculation?.monthlyInstallment === '8630.39' &&
      result.memo?.includes('Human decision required'),
    'SmokeMemoFailed',
    'Expected the code-calculated memo and pending human approval',
  );
  return {
    reference,
    policyEdition: result.policyEdition,
    status: result.status,
    usageRecords: result.usageRecords,
  };
});

await measure('grounded_policy_quote', async () => {
  const clause = clauses.find((chunk) => chunk.section === 'CP-4.1')!;
  const answer = await answerPolicyQuestion(
    {
      question: 'What is the maximum debt burden ratio under the applicable credit policy?',
      asOfDate: '2025-04-03',
    },
    {
      provider,
      search: { search: async () => [{ chunk: clause, similarity: 1 }] },
      prompt: await readFile('prompts/questions.txt', 'utf8'),
      minimumSimilarity: 0.65,
    },
  );
  invariant(
    !answer.refused &&
      answer.answer.includes('45%') &&
      answer.citations.some((citation) => citation.chunkId === clause.id) &&
      'generation' in answer &&
      answer.generation?.model === ollamaModel,
    'SmokeCitationFailed',
    'Expected an exact source quote selected by Ollama',
  );
  return { section: clause.section, generation: answer.generation };
});

await mkdir('artifacts/evaluation', { recursive: true });
const path = `artifacts/evaluation/fallback-${report.at.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`;
await writeFile(path, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${path}`);
if (report.results.some((result) => !result.passed)) process.exitCode = 1;
