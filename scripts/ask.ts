import { readFile } from 'node:fs/promises';
import { runtime } from './runtime.js';
import { RetrievalService } from '../packages/infrastructure/src/knowledge/retrieval.js';
import { answerPolicyQuestion } from '../packages/application/src/questions.js';
const { db, provider, config } = await runtime();
try {
  const question = process.argv[2] ?? '';
  const asOfDate =
    process.argv[3] ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  console.log(
    JSON.stringify(
      await answerPolicyQuestion(
        { question, asOfDate },
        {
          search: new RetrievalService(db, provider),
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
