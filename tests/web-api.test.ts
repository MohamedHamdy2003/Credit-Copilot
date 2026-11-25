import { ApiClient, ApiError } from '../apps/web/src/api.js';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
it('sends cookies, memory CSRF and stable idempotency without setting a multipart boundary', async () => {
  const calls: Parameters<typeof fetch>[] = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return new Response('{}', { status: 201 });
  };
  const client = new ApiClient();
  client.setCsrf('csrf');
  const form = new FormData();
  form.append('file', new Blob(['data']), 'source.pdf');
  await client.request('applications', { body: form, key: 'same-attempt' });
  expect(calls[0]).toEqual([
    '/api/v1/applications',
    expect.objectContaining({
      credentials: 'include',
      method: 'POST',
      body: form,
      headers: { 'x-csrf-token': 'csrf', 'Idempotency-Key': 'same-attempt' },
    }),
  ]);
  await client.request('knowledge/documents/CP-2025', { method: 'DELETE' });
  expect(calls[1]).toEqual([
    '/api/v1/knowledge/documents/CP-2025',
    expect.objectContaining({
      credentials: 'include',
      method: 'DELETE',
      headers: { 'x-csrf-token': 'csrf' },
    }),
  ]);
});
it('clears CSRF on expired sessions but keeps login failures local to the form', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: { code: 'Unauthenticated', message: 'Login required' },
        requestId: 'request',
      }),
      { status: 401 },
    );
  const client = new ApiClient();
  client.setCsrf('old');
  let expired = 0;
  client.onUnauthorized = () => {
    expired++;
  };
  await expect(client.request('auth/login', { body: {} })).rejects.toBeInstanceOf(ApiError);
  expect(expired).toBe(0);
  await expect(client.request('applications')).rejects.toMatchObject({
    status: 401,
    requestId: 'request',
  });
  expect(expired).toBe(1);
  let sent: RequestInit | undefined;
  globalThis.fetch = async (_url, init) => {
    sent = init;
    return new Response('{}');
  };
  await client.request('questions', { body: {} });
  expect(sent?.headers).toMatchObject({ 'x-csrf-token': '' });
});
it('preserves cancellation and reports network and non-JSON proxy errors without exposing content', async () => {
  const client = new ApiClient();
  globalThis.fetch = async () => {
    throw new DOMException('cancelled', 'AbortError');
  };
  await expect(client.request('applications')).rejects.toMatchObject({ name: 'AbortError' });
  globalThis.fetch = async () => {
    throw new TypeError('network');
  };
  await expect(client.request('applications')).rejects.toMatchObject({
    status: 0,
    code: 'NetworkUnavailable',
  });
  globalThis.fetch = async () =>
    new Response('<html>internal proxy details</html>', { status: 502 });
  await expect(client.request('applications')).rejects.toMatchObject({
    status: 502,
    message: 'The server could not process this request.',
  });
});
