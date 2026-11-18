import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './client';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('ApiClient', () => {
  it('sends the bearer token and parses JSON', async () => {
    const f = vi.fn(async () => json(200, { ok: true }));
    const c = new ApiClient('/api/v1', f as unknown as typeof fetch);
    c.setAccessToken('t1');
    expect(await c.get('/x')).toEqual({ ok: true });
    expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ headers: { Authorization: 'Bearer t1' } });
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(401, { error: { message: 'expired' } }))
      .mockResolvedValueOnce(json(200, { accessToken: 't2' }))
      .mockResolvedValueOnce(json(200, { ok: 2 }));
    const c = new ApiClient('/api/v1', f as unknown as typeof fetch);
    c.setAccessToken('t1');
    expect(await c.get('/x')).toEqual({ ok: 2 });
    expect(f.mock.calls[1][0]).toBe('/api/v1/auth/refresh');
    expect(f.mock.calls[2][1].headers.Authorization).toBe('Bearer t2');
  });

  it('signals session expiry when refresh fails', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(401, { error: { message: 'expired' } }))
      .mockResolvedValueOnce(json(401, { error: { message: 'no' } }));
    const c = new ApiClient('/api/v1', f as unknown as typeof fetch);
    const expired = vi.fn();
    c.onSessionExpired = expired;
    c.setAccessToken('t1');
    await expect(c.get('/x')).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledOnce();
    expect(c.isAuthenticated).toBe(false);
  });

  it('shares a single in-flight refresh between concurrent callers', async () => {
    let resolve!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const c = new ApiClient('/api/v1', f as unknown as typeof fetch);
    const a = c.refresh();
    const b = c.refresh();
    resolve(json(200, { accessToken: 'z' }));
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('surfaces the API error envelope', async () => {
    const f = vi.fn(async () => json(400, { error: { status: 400, message: 'Validation failed', details: ['email must be an email'] } }));
    const c = new ApiClient('/api/v1', f as unknown as typeof fetch);
    await expect(c.post('/users', {})).rejects.toMatchObject({ status: 400, message: 'Validation failed', details: ['email must be an email'] });
  });
});
