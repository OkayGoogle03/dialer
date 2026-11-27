import { describe, expect, it, vi } from 'vitest';
import { recordIncoming } from './incomingLog';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('recording a received call', () => {
  it('sends the reports in order, even when the call ends before the record exists, and only one end', async () => {
    const sent: string[] = [];
    let created: (v: { callId: string }) => void = () => undefined;
    const api = {
      post: vi.fn(() => new Promise((r) => { created = r as typeof created; })),
      patch: vi.fn(async (path: string, body: unknown) => { sent.push(`${path} ${(body as { status: string }).status}`); return {}; }),
    };
    const log = recordIncoming(api as never, 'acct', '4001', 'Asha');
    log.answered();
    log.finished('completed', 'Caller hung up');
    const last = log.finished('failed', 'again');
    await tick();
    expect(sent).toEqual([]);
    created({ callId: 'c1' });
    await last;
    expect(sent).toEqual(['/softphone/calls/c1 answered', '/softphone/calls/c1 completed']);
    expect(api.post).toHaveBeenCalledWith('/softphone/calls/incoming', { accountId: 'acct', from: '4001', callerName: 'Asha' });
  });

  it('stays quiet when the history cannot be saved', async () => {
    const api = { post: vi.fn(async () => { throw new Error('offline'); }), patch: vi.fn() };
    await expect(recordIncoming(api as never, 'acct', '4001').finished('failed', 'Missed')).resolves.toBeNull();
    expect(api.patch).not.toHaveBeenCalled();
  });
});
