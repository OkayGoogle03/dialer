/**
 * Business meaning of a finished call, per the call-list rules:
 *  SUCCESS      = the called party's phone was reached: answered, ringing (even if unanswered / cancelled), busy, on another call, declined or hung up.
 *                 The note says what the user did.
 *  NOT SUCCESS  = the call never reached a ringing phone: switched off, not reachable, number not found, call server / network / account problems.
 *                 The note says why it did not connect.
 */
export type Outcome = { status: 'success' | 'not_success'; note: string };

export interface OutcomeInput {
  /** how the softphone saw the end: 'completed' (BYE / cancel) or 'failed' (a final SIP error or a local failure) */
  final: 'completed' | 'failed';
  answered: boolean;
  /** the called phone was ringing (180/183 received) before the end */
  rang: boolean;
  cause?: string | null;
  sipCode?: number | null;
  seconds?: number | null;
}

const withCode = (text: string, code?: number | null, cause?: string | null) =>
  `${text}${code ? ` (${code}${cause && !/^\d+$/.test(cause) && cause.length < 60 && !text.includes(cause) ? ` ${cause}` : ''})` : ''}`;

export function classifyOutcome(i: OutcomeInput): Outcome {
  const cause = (i.cause ?? '').trim();
  const c = cause.toLowerCase();
  const code = i.sipCode ?? null;
  const ok = (note: string): Outcome => ({ status: 'success', note });
  const no = (note: string): Outcome => ({ status: 'not_success', note });

  if (i.final === 'completed') {
    if (i.answered) {
      const dur = i.seconds != null && i.seconds >= 0 ? ` after ${i.seconds}s` : '';
      if (/called party|remote|bye/.test(c)) return ok(`Call answered; the user disconnected the call${dur}`);
      if (/agent|local|terminated|hung up/.test(c)) return ok(`Call answered; the agent ended the call${dur}`);
      return ok(`Call answered and completed${dur}`);
    }
    if (/no ringing/.test(c)) return no(`Not connected: the phone did not ring within the limit (${cause})`);
    if (/ring limit|no answer/.test(c)) return ok(`Phone rang but the user did not answer (${cause.replace(/^no answer within /i, 'ring limit ').replace(/\s*\(ring limit\)/i, '')})`);
    if (i.rang) return ok('Phone rang; the call was cancelled before the user answered');
    return no('Call cancelled before the phone started ringing');
  }

  // failed
  // These codes after the phone had already been ringing are the PBX's own "nobody answered" timeout, not a server fault.
  if (i.rang && (code === 408 || code === 480 || code === 487 || /timeout|timed out|unavailable/.test(c) && !code)) return ok(withCode('Phone rang but the user did not answer', code, cause));
  switch (code) {
    case 486: case 600: return ok(withCode('Phone rang/connected: the user is busy or on another call', code, cause));
    case 603: return ok(withCode('Phone rang: the user declined / disconnected the call', code, cause));
    case 487: return i.rang ? ok('Phone rang; the call was cancelled before the user answered') : no('Call cancelled before the phone started ringing');
    case 480: return no(withCode('Not connected: the user\'s phone is switched off or not reachable', code, cause));
    case 404: case 410: case 604: case 484: case 485: return no(withCode('Not connected: number not found or invalid', code, cause));
    case 408: case 504: return no(withCode('Not connected: the call server did not respond in time', code, cause));
    case 401: case 403: case 407: return no(withCode('Not connected: the call server refused this SIP account (login or permission)', code, cause));
    case 488: case 415: case 606: return no(withCode('Not connected: the call server could not agree on audio (codec)', code, cause));
    case 503: case 500: case 502: case 513: return no(withCode('Not connected: call server or carrier problem', code, cause));
    default:
  }
  if (code && code >= 500) return no(withCode('Not connected: call server or carrier problem', code, cause));
  if (code && code >= 400) return no(withCode('Not connected: the call server rejected the call', code, cause));
  // no SIP code: classify by what the softphone reported
  if (/busy/.test(c)) return ok(`Phone rang/connected: the user is busy (${cause})`);
  if (/reject|declin/.test(c)) return ok(`Phone rang: the user declined the call (${cause})`);
  if (/unavailable|not reachable|switched off/.test(c)) return no(`Not connected: the user's phone is switched off or not reachable (${cause})`);
  if (/not found|address incomplete/.test(c)) return no(`Not connected: number not found or invalid (${cause})`);
  if (/timeout|timed out|connection|network|disconnected|transport/.test(c)) return no(`Not connected: call server or network problem (${cause})`);
  if (/media|microphone|codec/.test(c)) return no(`Not connected: audio problem on the agent's computer (${cause})`);
  if (/cancel/.test(c)) return i.rang ? ok('Phone rang; the call was cancelled before the user answered') : no('Call cancelled before the phone started ringing');
  return no(`Not connected: ${cause || 'unknown reason'}`);
}
