/* Is the voice really getting through? Judged from the browser's own call statistics (WebRTC getStats), browser calling only. */

export interface AudioSample {
  at: number;
  inPackets: number; inLost: number; outPackets: number;
  rttMs: number | null; jitterMs: number | null;
  /** the sound goes through the voice relay (TURN) instead of directly; null = not known yet */
  relayed: boolean | null;
}
export interface CallHealth { level: 'good' | 'weak' | 'bad'; text: string }

/** How far back the judgement looks: long enough that one late packet does not raise an alarm. */
export const WINDOW_MS = 5_000;
const LOSS_PERCENT = 5;
const SLOW_RTT_MS = 400;
const SHAKY_JITTER_MS = 60;

type Stat = Record<string, any>;

export function readSample(report: { forEach(cb: (s: Stat) => void): void }, at: number): AudioSample {
  const all = new Map<string, Stat>();
  report.forEach((s) => all.set(s.id, s));
  const sample: AudioSample = { at, inPackets: 0, inLost: 0, outPackets: 0, rttMs: null, jitterMs: null, relayed: null };
  let pairId: string | undefined;
  let fallback: Stat | undefined; // browsers without 'transport' statistics mark the pair itself
  for (const s of all.values()) {
    const audio = (s.kind ?? s.mediaType) === 'audio';
    if (s.type === 'inbound-rtp' && audio) {
      sample.inPackets += s.packetsReceived ?? 0;
      sample.inLost += Math.max(0, s.packetsLost ?? 0);
      if (typeof s.jitter === 'number') sample.jitterMs = Math.round(s.jitter * 1000);
    } else if (s.type === 'outbound-rtp' && audio) sample.outPackets += s.packetsSent ?? 0;
    else if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    else if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) fallback = s;
  }
  const pair = (pairId ? all.get(pairId) : undefined) ?? fallback;
  if (pair) {
    if (typeof pair.currentRoundTripTime === 'number') sample.rttMs = Math.round(pair.currentRoundTripTime * 1000);
    const ends = [all.get(pair.localCandidateId), all.get(pair.remoteCandidateId)];
    if (ends[0]) sample.relayed = ends.some((c) => c?.candidateType === 'relay');
  }
  return sample;
}

/** Keeps the newest sample and just enough older ones to cover the window. */
export function addSample(history: AudioSample[], next: AudioSample): AudioSample[] {
  const all = [...history, next];
  while (all.length > 2 && next.at - all[1].at >= WINDOW_MS) all.shift();
  return all;
}

/** null until the call has been watched long enough to say anything. */
export function judge(history: AudioSample[], muted: boolean): CallHealth | null {
  const first = history[0];
  const last = history[history.length - 1];
  if (!first || !last || last.at - first.at < WINDOW_MS) return null;
  const received = last.inPackets - first.inPackets;
  if (received <= 0) return { level: 'bad', text: 'No sound is arriving from the other side. Check the internet connection on both sides.' };
  if (!muted && last.outPackets - first.outPackets <= 0) return { level: 'bad', text: 'Your voice is not being sent. Check your microphone under "Call sound".' };
  const lost = Math.max(0, last.inLost - first.inLost);
  const percent = Math.round((lost / (lost + received)) * 100);
  const why = [
    percent >= LOSS_PERCENT ? `${percent}% of the sound is lost` : '',
    (last.rttMs ?? 0) >= SLOW_RTT_MS ? `delay ${last.rttMs} ms` : '',
    (last.jitterMs ?? 0) >= SHAKY_JITTER_MS ? 'uneven arrival' : '',
  ].filter(Boolean);
  if (why.length) return { level: 'weak', text: `Weak connection, the voice may break up: ${why.join(', ')}. Move closer to the Wi-Fi or use a better network.` };
  return { level: 'good', text: 'Voice connection is good' };
}

const DROP_GRACE_MS = 4_000; // a short blip usually heals by itself
const RESTART_EVERY_MS = 10_000;

/** Should a new network route be negotiated now (ICE restart)? `since` = when the connection first looked broken, null while it is fine. */
export function shouldRestartRoute(state: string, since: number | null, lastRestart: number, now: number): boolean {
  if (since === null || now - lastRestart < RESTART_EVERY_MS) return false;
  return state === 'failed' || (state === 'disconnected' && now - since >= DROP_GRACE_MS);
}
