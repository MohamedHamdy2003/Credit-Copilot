export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface Completion {
  value: unknown;
  model: string;
  usage: Usage;
}
export interface GenerationPort {
  completeStructured(system: string, data: string): Promise<Completion>;
}
export interface EmbeddingPort {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string, purpose: 'document' | 'query'): Promise<number[]>;
}
