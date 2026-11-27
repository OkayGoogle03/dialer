/* JsSIP sends its offer or answer only after the browser has finished looking for network routes (ICE gathering). On a PC with several
 * network adapters that can take 40 seconds: the call seems stuck and the other side's phone does not ring. Once usable routes are in hand
 * we tell JsSIP to go ahead. */

export interface IceCandidateEvent { candidate: { candidate?: string; type?: string | null }; ready: () => void }

const AFTER_RELAY_MS = 300; // the relay is the last route to arrive
const AFTER_PUBLIC_MS = 1_000; // public address found: give a relay a moment to arrive too
const AT_MOST_MS = 3_000; // counted from the first route, whatever it is
// With a voice relay configured it is worth a longer wait: on mobile data and strict office Wi-Fi the relay is often the only route
// that carries sound, and over TCP / TLS it can take a few seconds. Leaving without it connects the call with no voice.
const WAIT_FOR_RELAY_MS = 3_000;
const AT_MOST_WITH_RELAY_MS = 5_000;

/** Does the list of ICE servers contain a voice relay (TURN)? */
export const hasRelay = (servers: { urls: string | string[] }[] | undefined) => !!servers?.some((s) => [s.urls].flat().some((u) => /^turns?:/i.test(u)));

const kind = (c: IceCandidateEvent['candidate']) => c.type ?? / typ (\w+)/.exec(c.candidate ?? '')?.[1] ?? '';

/** Returns the handler for one call's 'icecandidate' events. */
export function createIceHurry({ relayExpected = false } = {}) {
  const afterPublic = relayExpected ? WAIT_FOR_RELAY_MS : AFTER_PUBLIC_MS;
  const atMost = relayExpected ? AT_MOST_WITH_RELAY_MS : AT_MOST_MS;
  let current: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline = 0;
  let scheduledAt = 0;

  return (e: IceCandidateEvent) => {
    if (current !== e.ready) { // a new offer / answer starts over
      if (timer) clearTimeout(timer);
      current = e.ready;
      timer = null;
      deadline = Date.now() + atMost;
    }
    const type = kind(e.candidate);
    const wait = type === 'relay' ? AFTER_RELAY_MS : type === 'srflx' ? afterPublic : atMost;
    const at = Math.min(deadline, Date.now() + wait);
    if (timer && at >= scheduledAt) return; // a later route can only bring the moment forward
    if (timer) clearTimeout(timer);
    scheduledAt = at;
    timer = setTimeout(e.ready, Math.max(0, at - Date.now()));
  };
}
