/* JsSIP sends its offer or answer only after the browser has finished looking for network routes (ICE gathering). On a PC with several
 * network adapters that can take 40 seconds: the call seems stuck and the other side's phone does not ring. Once usable routes are in hand
 * we tell JsSIP to go ahead. */

export interface IceCandidateEvent { candidate: { candidate?: string; type?: string | null }; ready: () => void }

const AFTER_RELAY_MS = 300; // the relay is the last route to arrive
const AFTER_PUBLIC_MS = 1_000; // public address found: give a relay a moment to arrive too
const AT_MOST_MS = 3_000; // counted from the first route, whatever it is

const kind = (c: IceCandidateEvent['candidate']) => c.type ?? / typ (\w+)/.exec(c.candidate ?? '')?.[1] ?? '';

/** Returns the handler for one call's 'icecandidate' events. */
export function createIceHurry() {
  let current: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline = 0;
  let scheduledAt = 0;

  return (e: IceCandidateEvent) => {
    if (current !== e.ready) { // a new offer / answer starts over
      if (timer) clearTimeout(timer);
      current = e.ready;
      timer = null;
      deadline = Date.now() + AT_MOST_MS;
    }
    const type = kind(e.candidate);
    const wait = type === 'relay' ? AFTER_RELAY_MS : type === 'srflx' ? AFTER_PUBLIC_MS : AT_MOST_MS;
    const at = Math.min(deadline, Date.now() + wait);
    if (timer && at >= scheduledAt) return; // a later route can only bring the moment forward
    if (timer) clearTimeout(timer);
    scheduledAt = at;
    timer = setTimeout(e.ready, Math.max(0, at - Date.now()));
  };
}
