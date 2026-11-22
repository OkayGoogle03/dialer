import { describe, expect, it } from 'vitest';
import { createRejectionTracker, credentialRejectedMessage, isCredentialRejection } from './registrationRetry';
import { uaKey, type SoftphoneAccount } from './useSoftphone';

const acct = (password: string): SoftphoneAccount => ({
  id: 'a1', sipId: '4001', displayName: null, password,
  callServer: { id: 's1', name: 'PBX', host: 'pbx.example.test', port: 8089, transport: 'wss', wsPath: '/ws', realm: null, webrtcUrl: 'wss://pbx.example.test:8089/ws', addressUpdatedAt: null },
});

describe('registration retry policy (protects the PBX from our own retries)', () => {
  it('only credential rejections are treated as "do not retry"', () => {
    for (const code of [401, 403, 407]) expect(isCredentialRejection(code)).toBe(true);
    for (const code of [undefined, null, 0, 408, 480, 500, 503]) expect(isCredentialRejection(code as number | undefined)).toBe(false);
  });

  it('the message tells the agent what to do and never contains secrets', () => {
    const m = credentialRejectedMessage(401, 'Unauthorized');
    expect(m).toMatch(/401 Unauthorized/);
    expect(m).toMatch(/Ask your administrator/);
    expect(m).toMatch(/does not keep retrying/);
  });

  it('a rejected identity stays blocked until the password (and so the softphone key) changes', () => {
    const t = createRejectionTracker();
    const bad = acct('old-password');
    expect(t.has(uaKey(bad))).toBe(false);
    t.add(uaKey(bad));
    expect(t.has(uaKey(bad))).toBe(true);        // reload of the same settings: no new REGISTER
    expect(t.has(uaKey(acct('new-password')))).toBe(false); // admin fixed the password: one new attempt is allowed
    t.add('');                                   // empty keys are ignored
    expect(t.size()).toBe(1);
    t.clear();
    expect(t.has(uaKey(bad))).toBe(false);
  });
});
