import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { productIds } from '../packages/contracts/src/products.js';
import { runtime } from './runtime.js';
import { RetrievalService } from '../packages/infrastructure/src/knowledge/retrieval.js';
import { answerPolicyQuestion } from '../packages/application/src/questions.js';
const { db, provider, config } = await runtime();
try {
  const question = process.argv[2] ?? '';
  const asOfDate =
    process.argv[3] ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  const product = z.enum(productIds).default('PL-100').parse(process.argv[4]);
  console.log(
    JSON.stringify(
      await answerPolicyQuestion(
        { question, asOfDate, product },
        {
          search: new RetrievalService(db, provider, config.RETRIEVAL_STRATEGY, config),
          provider,
          prompt: await readFile('prompts/questions.txt', 'utf8'),
          minimumSimilarity: config.RETRIEVAL_MIN_SIMILARITY,
        },
      ),
      null,
      2,
    ),
  );
} finally {
  await db.destroy();
}
