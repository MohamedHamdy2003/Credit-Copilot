export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
  }
}
/** HttpOnly cookies stay with the browser. CSRF is kept in memory only. */
export class ApiClient {
  private csrf = '';
  onUnauthorized?: () => void;
  setCsrf(value: string) {
    this.csrf = value;
  }
  async request<T>(
    path: string,
    options: { body?: unknown; key?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers['x-csrf-token'] = this.csrf;
      if (options.body instanceof FormData) body = options.body;
      else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
    }
    if (options.key) headers['Idempotency-Key'] = options.key;
    let response: Response;
    try {
      response = await fetch(`/api/v1/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'include',
        headers,
        body,
        signal: options.signal,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'AbortError'
      )
        throw error;
      throw new ApiError(
        0,
        'NetworkUnavailable',
        'Could not reach the server. Check the connection, then retry.',
      );
    }
    const data = await response.json().catch(() => null);
    if (options.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    if (!response.ok) {
      if (response.status === 401 && path !== 'auth/login') {
        this.csrf = '';
        this.onUnauthorized?.();
      }
      throw new ApiError(
        response.status,
        data?.error?.code ?? 'RequestFailed',
        data?.error?.message ?? 'The server could not process this request.',
        data?.requestId,
      );
    }
    return data as T;
  }
}
export const api = new ApiClient();
