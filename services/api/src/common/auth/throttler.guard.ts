import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectThrottlerOptions, InjectThrottlerStorage, ThrottlerGuard, ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { UUID_RE } from '../../database/database';
import type { AccessClaims } from './auth.types';

type Verify = (token: string) => Promise<AccessClaims>;

/**
 * Who a request is counted against by the rate limiter.
 *  - a request carrying a VALID (signed, unexpired) access token is counted per signed-in user, so many agents working behind one
 *    shared address (an office, a hotspot) do not use up each other's limit with their normal polling;
 *  - anything else (no token, bad token, login attempts) is counted per client address, which keeps password guessing and token
 *    flooding limited per address.
 * The token is verified, never just decoded, so nobody can choose another user's bucket or escape the limits with made-up tokens.
 */
/** IPv6 clients are counted per /64 (one customer network), so rotating addresses inside a /64 cannot escape the limit. */
export function normalizeIp(ip: string): string {
  const v = ip.trim();
  if (!v.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(v)) return v.replace(/^::ffff:/i, '');
  const [head, tail = ''] = v.split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = v.includes('::') && tail ? tail.split(':') : [];
  const groups = v.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export async function throttleTracker(req: { headers?: Record<string, unknown>; ip?: string }, verify: Verify): Promise<string> {
  const [scheme, token] = String(req.headers?.authorization ?? '').split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const claims = await verify(token);
      if (UUID_RE.test(claims.sub ?? '')) return `u:${claims.sub}`;
    } catch { /* invalid or expired: fall back to the address */ }
  }
  return `ip:${req.ip ? normalizeIp(req.ip) : 'unknown'}`;
}

@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
  ) { super(options, storage, reflector); }

  protected getTracker(req: Record<string, any>): Promise<string> {
    return throttleTracker(req, (t) => this.jwt.verifyAsync<AccessClaims>(t, { algorithms: ['HS256'] }));
  }
}
