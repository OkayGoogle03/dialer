import { createHmac } from 'node:crypto';
import { turnRestCredential } from './turn';

describe('TURN REST credentials (coturn use-auth-secret)', () => {
  const secret = 'unit-test-turn-secret';
  const user = '45b58fe8-1676-428f-86a7-1aee324b1a87';

  it('username is <expiry>:<user> and the credential is base64(HMAC-SHA1(secret, username))', () => {
    const now = Date.UTC(2026, 10, 22, 12, 0, 0);
    const c = turnRestCredential(secret, user, now, 3600);
    expect(c.username).toBe(`${Math.floor(now / 1000) + 3600}:${user}`);
    expect(c.credential).toBe(createHmac('sha1', secret).update(c.username).digest('base64'));
  });

  it('expires after the ttl and differs per user and per secret', () => {
    const now = Date.UTC(2026, 10, 22, 12, 0, 0);
    const a = turnRestCredential(secret, user, now, 60);
    expect(Number(a.username.split(':')[0])).toBe(Math.floor(now / 1000) + 60);
    expect(turnRestCredential(secret, 'other', now, 60).credential).not.toBe(a.credential);
    expect(turnRestCredential('another-secret', user, now, 60).credential).not.toBe(a.credential);
  });
});

import { SoftphoneService } from './softphone';

describe('what a browser receives as ICE servers', () => {
  const ice = (webrtc: object, userId = 'user-1') => (SoftphoneService.prototype as unknown as { iceServers(this: unknown, id: string): { urls: string[]; username?: string; credential?: string }[] }).iceServers.call({ appConfig: { webrtc } }, userId);
  const SECRET = 'very-secret-shared-with-coturn-only';

  it('TURN credentials are short-lived and derived; the shared secret itself never appears in what a browser gets', () => {
    const out = ice({ stunUrls: ['stun:s.example:3478'], turnUrls: ['turn:t.example:3478'], turnSecret: SECRET, turnTtlSeconds: 3600 });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    const turn = out.find((s) => s.urls.some((u) => u.startsWith('turn:')))!;
    expect(turn.username).toMatch(/^\d{10}:user-1$/);
    expect(Number(turn.username!.split(':')[0])).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3600);
    expect(turn.credential).toBe(createHmac('sha1', SECRET).update(turn.username!).digest('base64'));
  });

  it('no secret means no TURN entry at all (never a fixed password)', () => {
    expect(ice({ stunUrls: ['stun:s.example:3478'], turnUrls: ['turn:t.example:3478'], turnTtlSeconds: 3600 })).toEqual([{ urls: ['stun:s.example:3478'] }]);
  });
});
