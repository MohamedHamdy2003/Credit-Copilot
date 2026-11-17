export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = code;
  }
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
  status = 422,
): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}
