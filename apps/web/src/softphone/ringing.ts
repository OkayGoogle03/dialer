/* Ringing on both sides, and the auto-cut time. The sounds are generated in the browser, so there are no audio files. */

export type RingSound = 'ringback' | 'ringtone';

/** Which sound this call needs now: the person being called hears a ringtone, the caller a ringback while the other phone rings. */
export function ringSoundFor(call: { state: string; direction: 'out' | 'in'; earlyMedia?: boolean }): RingSound | null {
  if (call.state === 'incoming') return 'ringtone';
  // if the call server sends its own ringing audio, that is what the caller hears
  return call.state === 'ringing' && call.direction === 'out' && !call.earlyMedia ? 'ringback' : null;
}

/** Milliseconds after which an unanswered outgoing call is cut, or null when auto cut is off. */
export function ringLimitMs(serverLimit: number | null | undefined, systemDefault: number | undefined): number | null {
  if (serverLimit === null) return null;
  return Math.max(1, serverLimit ?? systemDefault ?? 5) * 1000;
}

/** Tone bursts (start, length in seconds) repeated every `every` seconds. */
const PATTERNS: Record<RingSound, { tones: number[]; bursts: [number, number][]; every: number; volume: number }> = {
  ringback: { tones: [400, 450], bursts: [[0, 0.4], [0.6, 0.4]], every: 3, volume: 0.06 },
  ringtone: { tones: [880, 1100], bursts: [[0, 0.35], [0.45, 0.35], [0.9, 0.35]], every: 2.5, volume: 0.18 },
};

export function createRingPlayer() {
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let live: OscillatorNode[] = [];

  const context = () => {
    if (!ctx && typeof AudioContext !== 'undefined') ctx = new AudioContext();
    if (ctx?.state === 'suspended') void ctx.resume().catch(() => undefined);
    return ctx;
  };

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    for (const o of live) { try { o.stop(); o.disconnect(); } catch { /* already stopped */ } }
    live = [];
    try { navigator.vibrate?.(0); } catch { /* not supported */ }
  }

  function play(sound: RingSound) {
    stop();
    const p = PATTERNS[sound];
    const cycle = () => {
      if (sound === 'ringtone') { try { navigator.vibrate?.([350, 100, 350, 100, 350]); } catch { /* not supported */ } }
      const c = context();
      if (!c) return;
      live = [];
      for (const [at, length] of p.bursts) {
        const gain = c.createGain();
        gain.gain.value = p.volume;
        gain.connect(c.destination);
        for (const hz of p.tones) {
          const o = c.createOscillator();
          o.frequency.value = hz;
          o.connect(gain);
          o.start(c.currentTime + at);
          o.stop(c.currentTime + at + length);
          live.push(o);
        }
      }
    };
    cycle();
    timer = setInterval(cycle, p.every * 1000);
  }

  return { play, stop, unlock: () => { context(); } };
}
