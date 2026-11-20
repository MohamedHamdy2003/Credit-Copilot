import type { ZodType } from 'zod';

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
  private failure(response: Response, path: string, data: ApiFailure | null) {
    if (response.status === 401 && path !== 'auth/login') {
      this.csrf = '';
      this.onUnauthorized?.();
    }
    return new ApiError(
      response.status,
      data?.error?.code ?? 'RequestFailed',
      data?.error?.message ?? 'The server could not process this request.',
      data?.requestId,
    );
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
    if (!response.ok) throw this.failure(response, path, data);
    return data as T;
  }

  async follow<T extends { kind: string }>(
    path: string,
    schema: ZodType<T>,
    options: {
      signal: AbortSignal;
      onEvent: (event: T) => void;
      onReconnect: (active: boolean) => void;
    },
  ): Promise<T> {
    let cursor = 0;
    let retries = 0;
    while (!options.signal.aborted) {
      try {
        const response = await fetch(`/api/v1/${path}`, {
          credentials: 'include',
          headers: {
            Accept: 'text/event-stream',
            ...(cursor ? { 'Last-Event-ID': String(cursor) } : {}),
          },
          signal: options.signal,
        });
        if (!response.ok)
          throw this.failure(response, path, await response.json().catch(() => null));
        if (
          !response.body ||
          !response.headers.get('content-type')?.startsWith('text/event-stream')
        ) {
          throw invalidStream();
        }
        options.onReconnect(false);
        for await (const frame of streamFrames(response.body)) {
          options.signal.throwIfAborted();
          if (frame.id <= cursor) continue;
          const parsed = schema.safeParse(frame.data);
          if (!parsed.success) throw invalidStream();
          cursor = frame.id;
          retries = 0;
          if (parsed.data.kind === 'completed' || parsed.data.kind === 'failed') return parsed.data;
          options.onEvent(parsed.data);
        }
      } catch (error) {
        options.signal.throwIfAborted();
        if (error instanceof ApiError && error.status < 500) throw error;
      }
      if (retries === 3) break;
      options.onReconnect(true);
      await abortableDelay(300 * 2 ** retries++, options.signal);
    }
    options.signal.throwIfAborted();
    throw new ApiError(
      0,
      'StreamDisconnected',
      'Connection lost. Retry to reconnect to the same request.',
    );
  }
}
export const api = new ApiClient();

interface ApiFailure {
  error?: { code?: string; message?: string };
  requestId?: string;
}

const invalidStream = () =>
  new ApiError(422, 'InvalidStream', 'The server returned an invalid live update.');

async function* streamFrames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\n\n');
        if (block.startsWith(':')) continue;
        const match = /^id: ([1-9]\d{0,8})\ndata: (.+)$/.exec(block);
        if (!match) throw invalidStream();
        const data = parseFrameData(match[2]!);
        yield { id: Number(match[1]), data };
      }
      if (buffer.length > 64_000) throw invalidStream();
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseFrameData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw invalidStream();
  }
}

function abortableDelay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
