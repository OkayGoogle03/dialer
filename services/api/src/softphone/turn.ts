import { createHmac } from 'node:crypto';

/**
 * Short-lived TURN credentials ("TURN REST API", the scheme coturn implements with `use-auth-secret` / `static-auth-secret`):
 *   username   = <unix expiry time>:<user id>
 *   credential = base64( HMAC-SHA1( shared secret, username ) )
 * The shared secret never leaves the API and the PBX host; each signed-in agent gets a username/credential pair that stops working
 * after `ttlSeconds`, so a leaked pair cannot be used as a permanent free relay.
 */
export function turnRestCredential(secret: string, userId: string, nowMs: number, ttlSeconds: number): { username: string; credential: string } {
  const expiry = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expiry}:${userId}`;
  return { username, credential: createHmac('sha1', secret).update(username).digest('base64') };
}
