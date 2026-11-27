import { MutableRefObject, RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { addSample, AudioSample, CallHealth, judge, readSample, shouldRestartRoute } from './callHealth';
import type { ActiveCall } from './useSoftphone';

const CHECK_MS = 1_500;

interface Options {
  call: ActiveCall;
  session: MutableRefObject<any>;
  audio: RefObject<HTMLAudioElement | null>;
  /** the chosen microphone ('' = the device's default) */
  micId: MutableRefObject<string>;
  /** a replacement microphone was opened during the call: it has to be closed when the call is over */
  opened(track: MediaStreamTrack): void;
}

/**
 * Keeps the voice of a call alive: plays the other side even when the browser holds sound back, tells the agent when no sound is
 * getting through, finds a new network route after a drop (Wi-Fi to mobile data) and reopens a microphone that stopped.
 */
export function useCallAudio({ call, session, audio, micId, opened }: Options) {
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [health, setHealth] = useState<CallHealth | null>(null);
  const [relayed, setRelayed] = useState<boolean | null>(null);
  const callRef = useRef(call);
  callRef.current = call;

  const play = useCallback(() => {
    const el = audio.current;
    if (!el?.srcObject) return;
    el.play().then(() => setSoundBlocked(false)).catch((e) => { if (e?.name === 'NotAllowedError') setSoundBlocked(true); });
  }, [audio]);

  /** Plays the other party's audio. For an OUTGOING call JsSIP creates the peer connection inside ua.call() (before it returns), so this must be
   *  registered through the call's eventHandlers, not with session.on() afterwards: a late listener never fires and the caller hears nothing. */
  const attachRemoteAudio = useCallback((pc: RTCPeerConnection) => {
    pc.ontrack = (ev: RTCTrackEvent) => {
      if (!audio.current || ev.track.kind !== 'audio') return;
      // some call servers send the track without a stream around it: it must still be heard
      audio.current.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
      play();
    };
  }, [audio, play]);

  // sound the browser held back starts with the next touch, and again after returning from another app or a locked screen
  const talking = call.state !== 'idle';
  useEffect(() => {
    if (!talking) return;
    const again = () => { if (document.visibilityState === 'visible' && audio.current?.paused) play(); };
    window.addEventListener('pointerdown', again);
    document.addEventListener('visibilitychange', again);
    return () => { window.removeEventListener('pointerdown', again); document.removeEventListener('visibilitychange', again); };
  }, [talking, audio, play]);

  useEffect(() => {
    if (talking) return;
    setSoundBlocked(false); setHealth(null); setRelayed(null);
    if (audio.current) audio.current.srcObject = null;
  }, [talking, audio]);

  useEffect(() => {
    if (call.state !== 'in_call') { setHealth(null); return; }
    let history: AudioSample[] = [];
    let brokenSince: number | null = null;
    let lastRestart = 0;
    let busy = false;
    let reopening = false;
    let over = false;
    const check = async () => {
      const s = session.current;
      const pc = s?.connection as RTCPeerConnection | undefined;
      if (busy || !pc?.getStats) return; // the Windows app's UDP / TCP engine has no browser connection
      busy = true;
      try {
        const now = Date.now();
        const state = pc.iceConnectionState;
        if (state === 'disconnected' || state === 'failed') brokenSince ??= now; else brokenSince = null;
        if (shouldRestartRoute(state, brokenSince, lastRestart, now) && typeof s.renegotiate === 'function') {
          // false = the call cannot be renegotiated at this moment: try again at the next check
          if (s.renegotiate({ rtcOfferConstraints: { iceRestart: true } }) !== false) lastRestart = now;
        }

        const sender = pc.getSenders().find((x) => x.track?.kind === 'audio');
        if (sender?.track?.readyState === 'ended' && !reopening) {
          reopening = true; // unplugged headset, or the phone took the microphone away
          const chosen = micId.current;
          navigator.mediaDevices.getUserMedia({ audio: chosen ? { deviceId: { ideal: chosen } } : true, video: false })
            .then(async (stream) => {
              const track = stream.getAudioTracks()[0];
              if (over || session.current !== s) { track.stop(); return; }
              track.enabled = !callRef.current.muted;
              await sender.replaceTrack(track);
              opened(track);
            })
            .catch(() => undefined) // reported by the health line ("your voice is not being sent")
            .finally(() => { reopening = false; });
        }

        const sample = readSample(await pc.getStats(), now);
        if (over) return;
        history = addSample(history, sample);
        if (sample.relayed !== null) setRelayed(sample.relayed);
        setHealth(brokenSince !== null ? { level: 'bad', text: 'The connection dropped. Reconnecting the voice…' } : judge(history, callRef.current.muted));
      } catch { /* the connection closed while it was being read */ } finally { busy = false; }
    };
    const t = setInterval(() => void check(), CHECK_MS);
    return () => { over = true; clearInterval(t); };
  }, [call.state, session, micId, opened]);

  return { attachRemoteAudio, soundBlocked, enableSound: play, health, relayed };
}
