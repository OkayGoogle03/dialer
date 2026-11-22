/**
 * Registration rejected for a wrong SIP username / password (401, 403) must NOT be retried automatically: every retry is another
 * failed login on the PBX, and the PBX's brute-force protection (fail2ban) would block the agent's address - and everyone behind the
 * same address. Network problems (no answer, socket closed) are still retried; a rejected credential is only tried again after
 * the credential or the server address changed (the softphone's key changes) or the page is reloaded.
 */
export const isCredentialRejection = (statusCode: number | undefined | null) => statusCode === 401 || statusCode === 403 || statusCode === 407;

export const credentialRejectedMessage = (statusCode: number | undefined | null, reason?: string) =>
  `Registration rejected (${statusCode}${reason ? ` ${reason.trim()}` : ''}): the SIP username or password is wrong. Ask your administrator to check them. `
  + 'This page does not keep retrying (that would get this address blocked) and tries again by itself as soon as the settings change.';

/** Remembers which softphone identities (account + password + server address) the PBX has rejected. */
export function createRejectionTracker() {
  const keys = new Set<string>();
  return { add: (key: string) => { if (key) keys.add(key); }, has: (key: string) => keys.has(key), clear: () => keys.clear(), size: () => keys.size };
}
