import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DomainError } from '../../../domain/src/errors.js';

/** Call from composition root; application services receive prompt content via dependency injection. */
export async function loadExtractionPrompt(projectDirectory: string): Promise<string> {
  try {
    const prompt = await readFile(resolve(projectDirectory, 'prompts/extraction.txt'), 'utf8');
    if (!prompt.trim()) throw new Error('Empty prompt');
    return prompt;
  } catch {
    throw new DomainError('PromptNotConfigured', 'Extraction prompt is missing or empty', 503);
  }
}
