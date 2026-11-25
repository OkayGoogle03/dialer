import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { errText } from '../components/kit';
import { isNativeTransport, nativeAvailable, startNative } from './nativeEngine';
import { createRejectionTracker, credentialRejectedMessage, isCredentialRejection } from './registrationRetry';

export interface SoftphoneAccount {
  id: string; sipId: string; displayName: string | null; password: string;
  callServer: { id: string; name: string; host: string | null; port: number | null; transport: string; connectionMode?: 'direct' | 'bridge'; wsPath: string; realm: string | null; webrtcUrl: string | null; addressUpdatedAt: string | null };
}
export interface DialOption { assignmentId: string; processId: string; processName: string; prefix: string; callServerId: string }
export interface IceServer { urls: string | string[]; username?: string; credential?: string }
export interface SoftphoneConfig { accounts: SoftphoneAccount[]; dialOptions: DialOption[]; fetchedAt: string; ringTimeoutSeconds?: number; iceServers?: IceServer[] }

export type RegState = 'idle' | 'connecting' | 'registered' | 'failed' | 'unavailable';
export type CallState = 'idle' | 'dialing' | 'ringing' | 'in_call' | 'incoming';
export interface ActiveCall { state: CallState; number: string; direction: 'out' | 'in'; startedAt: number | null; muted: boolean; callId: string | null; note: string | null; /** the note reports a normal / successful end (shown as a success message, not an error) */ noteOk?: boolean }

const IDLE_CALL: ActiveCall = { state: 'idle', number: '', direction: 'out', startedAt: null, muted: false, callId: null, note: null };
/** Agents pick up an admin's IP change within this time even if the connection never drops. */
const REFETCH_MS = 5 * 60_000;
const ACTIVE_CHECK_MS = 10_000;
const RETRY_MS = 30_000;

/** Identity of everything that needs a new SIP UA when it changes (address, credentials). */
export const uaKey = (a: SoftphoneAccount | undefined) => (a ? [a.id, a.sipId, a.password, a.callServer.webrtcUrl, a.callServer.realm, a.callServer.transport, a.callServer.host, a.callServer.port].join('|') : '');

/**
 * Browser (WebRTC) softphone engine on JsSIP. It registers the agent's own SIP account with the call server the admin
 * configured, re-reads that configuration at login, on reconnect, when the tab regains focus and every few minutes, and
 * restarts the registration if the server's address changed (dynamic IP).
 */
export function useSoftphone() {
  const [config, setConfig] = useState<SoftphoneConfig | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [reg, setReg] = useState<RegState>('idle');
  const [regError, setRegError] = useState<string | null>(null);
  const [call, setCall] = useState<ActiveCall>(IDLE_CALL);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const ua = useRef<any>(null);
  const session = useRef<any>(null);
  const keyRef = useRef('');
  // identities (account + password + server) the PBX rejected: never retried automatically, see registrationRetry.ts
  const rejected = useRef(createRejectionTracker());
  const audio = useRef<HTMLAudioElement | null>(null);
  const accountRef = useRef<SoftphoneAccount | undefined>(undefined);
  const regRef = useRef<RegState>('idle');
  regRef.current = reg;
  const regErrRef = useRef<string | null>(null);
  regErrRef.current = regError;
  const configRef = useRef<SoftphoneConfig | null>(null);
  configRef.current = config;
  const callRef = useRef(call);
  callRef.current = call;

  const account = config?.accounts.find((a) => a.id === accountId) ?? config?.accounts[0];
  accountRef.current = account;

  // ---- audio devices (browser calling): the agent's own microphone and speaker, remembered on this computer
  const store = (k: string, v?: string) => { try { if (v === undefined) return localStorage.getItem(k) ?? ''; if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* storage blocked */ } return v ?? ''; };
  const [micId, setMicIdState] = useState(() => store('dialer.micId'));
  const [speakerId, setSpeakerIdState] = useState(() => store('dialer.speakerId'));
  const [devices, setDevices] = useState<{ mics: MediaDeviceInfo[]; speakers: MediaDeviceInfo[]; labelled: boolean }>({ mics: [], speakers: [], labelled: false });
  const micRef = useRef(micId);
  micRef.current = micId;
  const setMicId = useCallback((id: string) => { setMicIdState(id); store('dialer.micId', id); }, []);
  const setSpeakerId = useCallback((id: string) => { setSpeakerIdState(id); store('dialer.speakerId', id); }, []);
  const loadDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices({ mics: all.filter((d) => d.kind === 'audioinput'), speakers: all.filter((d) => d.kind === 'audiooutput'), labelled: all.some((d) => d.label) });
    } catch { /* no media devices API */ }
  }, []);
  /** Asks for microphone permission once so the browser reveals the device names. */
  const grantMic = useCallback(async () => {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch { setError('Microphone permission was not given. Allow the microphone for this site in the browser address bar.'); }
    await loadDevices();
  }, [loadDevices]);
  useEffect(() => { void loadDevices(); navigator.mediaDevices?.addEventListener?.('devicechange', loadDevices); return () => navigator.mediaDevices?.removeEventListener?.('devicechange', loadDevices); }, [loadDevices]);
  const sinkSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  useEffect(() => { const el = audio.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null; if (el?.setSinkId) void el.setSinkId(speakerId || 'default').catch(() => undefined); }, [speakerId, call.state]);
  const mediaConstraints = () => ({ audio: micRef.current ? { deviceId: { exact: micRef.current } } : true, video: false });
  const rtcConfig = () => ({ iceServers: configRef.current?.iceServers?.length ? configRef.current.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }] });

  const report = useCallback((id: string, state: 'registered' | 'unregistered' | 'failed', msg?: string) => {
    api.post('/softphone/registration', { accountId: id, state, ...(msg ? { error: msg.slice(0, 300) } : {}) }).catch(() => undefined);
  }, []);

  const stopUa = useCallback(() => {
    const u = ua.current;
    ua.current = null;
    keyRef.current = '';
    if (u) { try { u.stop(); } catch { /* already stopped */ } }
  }, []);

  const finishCall = useCallback(() => { session.current = null; setCall(IDLE_CALL); }, []);

  const track = useCallback((id: string | null, status: 'ringing' | 'answered' | 'completed' | 'failed', extra: Record<string, unknown> = {}) => {
    if (id) api.patch(`/softphone/calls/${id}`, { status, ...extra }).catch(() => undefined);
  }, []);

  /** Plays the other party's audio. For an OUTGOING call JsSIP creates the peer connection inside ua.call() (before it returns), so this must be
   *  registered through the call's eventHandlers, not with session.on() afterwards: a late listener never fires and the caller hears nothing. */
  const attachRemoteAudio = useCallback((pc: RTCPeerConnection) => {
    pc.ontrack = (ev: RTCTrackEvent) => {
      if (audio.current && ev.streams[0]) { audio.current.srcObject = ev.streams[0]; void audio.current.play().catch(() => undefined); }
    };
  }, []);

  const wireSession = useCallback((s: any, base: ActiveCall) => {
    session.current = s;
    setCall(base);
    // Maximum ringing time at the called party (server setting, default 5 s): after that the call is cancelled and recorded as not answered.
    const ringMs = Math.max(1, configRef.current?.ringTimeoutSeconds ?? 5) * 1000;
    let ringTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const clearRing = () => { if (ringTimer) { clearTimeout(ringTimer); ringTimer = null; } };
    const timeoutCause = () => (sawRinging ? `No answer within ${ringMs / 1000} s (ring limit)` : `No ringing within ${ringMs / 1000} s (the call server only sent progress / early media)`);
    let sawRinging = false;
    s.on('progress', () => {
      // JsSIP also emits 'progress' for an INCOMING call when it sends its own 180 Ringing; that must not replace the Answer / Reject screen.
      if (base.direction === 'in') return;
      // 180 Ringing and 183 Session Progress (ringback / early media) both mean the call server is ringing the user's phone.
      if (!sawRinging) { sawRinging = true; track(base.callId, 'ringing'); }
      setCall((c) => ({ ...c, state: 'ringing' }));
      if (base.direction === 'out' && !ringTimer && !timedOut) ringTimer = setTimeout(() => { timedOut = true; try { s.terminate(); } catch { /* already ended */ } }, ringMs);
    });
    s.on('accepted', () => {
      clearRing();
      setCall((c) => ({ ...c, state: 'in_call', startedAt: Date.now() }));
      track(base.callId, 'answered');
    });
    s.on('peerconnection', (e: any) => attachRemoteAudio(e.peerconnection)); // incoming calls: the connection is created at answer(), after this runs
    s.on('failed', (e: any) => {
      clearRing();
      if (timedOut) { track(base.callId, 'completed', { cause: timeoutCause() }); setCall({ ...IDLE_CALL, note: timeoutCause() + ' - call disconnected' }); session.current = null; return; }
      const code = e?.message?.status_code as number | undefined;
      const phrase = e?.message?.reason_phrase as string | undefined;
      const failedNote = `Call failed: ${e?.cause ?? 'unknown'}${code ? ` (${code})` : ''}`;
      const body = { status: 'failed', cause: `${e?.cause ?? 'failed'}${phrase && !String(e?.cause ?? '').includes(phrase) ? ` - ${phrase}` : ''}`.slice(0, 100), ...(code ? { sipCode: code } : {}) };
      session.current = null;
      if (!base.callId) { setCall({ ...IDLE_CALL, note: failedNote }); return; }
      // The server decides what the end of the call means (same rule as Recent calls and the call lists): declined / no answer / busy are Success ("Call ended"), the rest keep "Call failed".
      setCall(IDLE_CALL);
      api.patch<{ outcome?: { status: string; note: string } }>(`/softphone/calls/${base.callId}`, body)
        .then((r) => setCall((c) => (c.state !== 'idle' || c.note ? c : { ...IDLE_CALL, note: r?.outcome?.status === 'success' ? `Call ended: ${r.outcome.note}`.slice(0, 200) : failedNote, noteOk: r?.outcome?.status === 'success' })))
        .catch(() => setCall((c) => (c.state !== 'idle' || c.note ? c : { ...IDLE_CALL, note: failedNote })));
    });
    s.on('ended', (e: any) => {
      clearRing();
      if (timedOut) { track(base.callId, 'completed', { cause: timeoutCause() }); setCall({ ...IDLE_CALL, note: timeoutCause() + ' - call disconnected' }); session.current = null; return; }
      const remote = e?.originator === 'remote' || /remote/i.test(String(e?.cause ?? ''));
      track(base.callId, 'completed', { cause: remote ? 'Called party disconnected' : 'Agent ended the call' }); finishCall();
    });
  }, [finishCall, track, attachRemoteAudio]);

  const startUa = useCallback(async (acct: SoftphoneAccount) => {
    stopUa();
    if (isNativeTransport(acct.callServer.transport)) {
      if (!nativeAvailable()) { setReg('unavailable'); setRegError(`This call server uses ${acct.callServer.transport.toUpperCase()} SIP. That works on a Windows PC with the Project Dialer app. On this device, ask your administrator to switch the call server to Direct browser-to-PBX (WSS).`); return; }
      setReg('connecting'); setRegError(null);
      const key = uaKey(acct);
      keyRef.current = key;
      if (rejected.current.has(key)) { setReg('failed'); setRegError(credentialRejectedMessage(401)); return; }
      try {
        const native = await startNative({ host: acct.callServer.host ?? '', port: acct.callServer.port ?? (acct.callServer.transport === 'tcp' ? 5060 : 5060), transport: acct.callServer.transport, sipId: acct.sipId, password: acct.password, realm: acct.callServer.realm, displayName: acct.displayName }, {
          onRegistered: () => { if (keyRef.current !== key) return; setReg('registered'); setRegError(null); report(acct.id, 'registered'); },
          onFailed: (m) => { if (keyRef.current !== key) return; if (/rejected the SIP ID or password/i.test(m)) rejected.current.add(key); setReg('failed'); setRegError(`Registration failed: ${m}`); report(acct.id, 'failed', m); },
          onDisconnected: () => { if (keyRef.current !== key) return; setReg('failed'); setRegError('Connection to the call server was lost.'); report(acct.id, 'failed', 'connection lost'); },
          onIncoming: (s, from) => { if (session.current) { s.terminate(); return; } wireSession(s, { ...IDLE_CALL, state: 'incoming', direction: 'in', number: from }); },
        });
        // while connecting (the app may be asking to allow this website) the account may have changed or been deactivated: drop this one
        if (keyRef.current !== key) { native.stop(); return; }
        ua.current = { call: native.call, stop: native.stop };
      } catch (e) {
        if (keyRef.current !== key) return;
        const why = e instanceof Error ? e.message : 'error';
        setReg('failed'); setRegError(why); report(acct.id, 'failed', why);
      }
      return;
    }
    if (!acct.callServer.webrtcUrl) { setReg('unavailable'); setRegError('This call server is configured with a transport the browser cannot use (needs WSS/WS).'); return; }
    const identity = uaKey(acct);
    if (rejected.current.has(identity)) {
      // same rejected credentials as before: no new REGISTER (the PBX would count another failed login)
      keyRef.current = identity; setReg('failed'); setRegError(credentialRejectedMessage(401)); return;
    }
    const { default: JsSIP } = await import('jssip');
    const realm = acct.callServer.realm || acct.callServer.host || '';
    setReg('connecting'); setRegError(null);
    const socket = new JsSIP.WebSocketInterface(acct.callServer.webrtcUrl);
    const u = new JsSIP.UA({
      sockets: [socket], uri: `sip:${acct.sipId}@${realm}`, password: acct.password, display_name: acct.displayName ?? acct.sipId,
      register: true, register_expires: 300, session_timers: false, connection_recovery_min_interval: 2, connection_recovery_max_interval: 30,
    });
    // a stopped UA keeps emitting events (e.g. 'disconnected'); ignore everything that is not the current UA
    const cur = () => ua.current === u;
    u.on('connected', () => cur() && setReg((r) => (r === 'registered' ? r : 'connecting')));
    u.on('disconnected', () => { if (!cur()) return; setReg('failed'); setRegError(`Cannot reach the call server at ${acct.callServer.webrtcUrl}. Check: (1) the address/port in Call Servers, (2) the PBX accepts WebSocket SIP on that port, (3) on this https site the address must be wss:// with a certificate the browser trusts (a bare IP usually needs a domain name + certificate), (4) firewall. If the IP changed, your admin updates it and this page picks it up automatically.`); report(acct.id, 'failed', 'transport disconnected'); });
    u.on('registered', () => { if (!cur()) return; setReg('registered'); setRegError(null); report(acct.id, 'registered'); });
    u.on('unregistered', () => { if (!cur()) return; setReg('idle'); report(acct.id, 'unregistered'); });
    u.on('registrationFailed', (e: any) => {
      if (!cur()) return;
      const code = e?.response?.status_code as number | undefined;
      const msg = `Registration rejected${code ? ` (${code} ${e.response.reason_phrase ?? ''})` : ''}`.trim();
      if (isCredentialRejection(code)) rejected.current.add(identity);
      setReg('failed'); setRegError(isCredentialRejection(code) ? credentialRejectedMessage(code, e.response.reason_phrase) : msg); report(acct.id, 'failed', msg);
    });
    u.on('newRTCSession', (e: any) => {
      if (!cur()) return;
      if (e.originator !== 'remote') return; // outgoing sessions are wired in dial()
      if (session.current) { e.session.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); return; }
      const from = e.request?.from?.uri?.user ?? 'unknown';
      wireSession(e.session, { ...IDLE_CALL, state: 'incoming', direction: 'in', number: from });
    });
    ua.current = u;
    keyRef.current = uaKey(acct);
    u.start();
  }, [report, stopUa, wireSession]);

  /** Re-read config; restart registration only when something relevant (address / credentials) changed. */
  const refresh = useCallback(async () => {
    try {
      const c = await api.get<SoftphoneConfig>('/softphone/config');
      setConfig(c); setError(null);
      const a = c.accounts.find((x) => x.id === accountRef.current?.id) ?? c.accounts[0];
      if (!a) {
        // no usable account left (its call server was disabled): unregister so the call server stops sending us calls, and drop a call that is only ringing
        const gone = accountRef.current?.id;
        stopUa(); setReg('idle'); if (gone) report(gone, 'unregistered');
        if (callRef.current.state === 'incoming') finishCall();
        return;
      }
      if (uaKey(a) !== keyRef.current && !callRef.current.callId) await startUa(a); // never tear down a live call
    } catch (e) { setError(errText(e, 'Could not load softphone settings')); }
    finally { setLoaded(true); }
  }, [startUa, stopUa, report, finishCall]);

  // Every few seconds ask which accounts are usable; any difference from what this softphone knows triggers an immediate refresh.
  // This is what makes "disable the call server" take effect within seconds (unregister, no inbound calls) and "enable" bring it back.
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const { accountIds } = await api.get<{ accountIds: string[] }>('/softphone/active');
        const known = (configRef.current?.accounts ?? []).map((x) => x.id).sort().join(',');
        if (accountIds.slice().sort().join(',') !== known) void refresh();
      } catch { /* offline: the normal refresh and retry loops cover it */ }
    }, ACTIVE_CHECK_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // login / mount, periodic refresh, tab focus, network back
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFETCH_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); window.removeEventListener('online', onFocus); stopUa(); };
  }, [refresh, stopUa]);

  // while not registered, retry and re-read the (possibly changed) server address
  useEffect(() => {
    if (reg !== 'failed' || rejected.current.has(keyRef.current)) return; // a rejected password is not retried (registrationRetry.ts)
    const t = setInterval(() => { keyRef.current = ''; void refresh(); }, RETRY_MS);
    return () => clearInterval(t);
  }, [reg, refresh]);

  // switching account
  useEffect(() => { if (account && uaKey(account) !== keyRef.current && !callRef.current.callId) void startUa(account); }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Dials what the server returned (prefix already applied) and wires the call events. */
  const startCall = useCallback(async (placed: { callId: string; dialed: string; prefix: string; target: string }) => {
    const s = await ua.current.call(placed.target, {
      mediaConstraints: mediaConstraints(), rtcOfferConstraints: { offerToReceiveAudio: true }, pcConfig: rtcConfig(),
      eventHandlers: { peerconnection: (e: { peerconnection: RTCPeerConnection }) => attachRemoteAudio(e.peerconnection) },
    });
    wireSession(s, { ...IDLE_CALL, state: 'dialing', number: placed.dialed, callId: placed.callId, note: placed.prefix ? `Prefix ${placed.prefix} applied` : null });
  }, [wireSession, attachRemoteAudio]);

  const dial = useCallback(async (destination: string, assignmentId?: string) => {
    const acct = accountRef.current;
    if (!acct || !ua.current || reg !== 'registered') { setError('Not registered with the call server yet.'); return; }
    setError(null);
    try {
      const placed = await api.post<{ callId: string; dialed: string; prefix: string; target: string }>('/softphone/calls', { accountId: acct.id, destination, ...(assignmentId ? { assignmentId } : {}) });
      await startCall(placed);
    } catch (e) { setError(errText(e, 'Could not place the call')); }
  }, [reg, startCall]);

  /** Dials one row of an Excel call list. Each row names its own call server and SIP ID: the softphone switches its registration to that account first. */
  const dialItem = useCallback(async (listId: string, item: { id: string; serverHost: string | null; sipId: string | null }): Promise<boolean> => {
    if (callRef.current.state !== 'idle') { setError('A call is already in progress.'); return false; }
    const accts = configRef.current?.accounts ?? [];
    const host = (item.serverHost ?? '').toLowerCase();
    const target = accts.find((x) => x.sipId === item.sipId && (x.callServer.host ?? '').toLowerCase() === host);
    if (!target) { setError(`No SIP account ${item.sipId} on ${item.serverHost} was found. Reload the page; ask your admin if it still fails.`); return false; }
    setError(null);
    if (keyRef.current !== uaKey(target) || regRef.current !== 'registered') {
      if (accountRef.current?.id !== target.id) setAccountId(target.id);
      else if (regRef.current === 'failed') { keyRef.current = ''; void refresh(); }
      const t0 = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 250));
        if (keyRef.current === uaKey(target) && regRef.current === 'registered' && ua.current) break;
        if (Date.now() - t0 > 12000) { setError(`Could not register ${target.sipId} on ${target.callServer.name}: ${regErrRef.current ?? 'no response from the call server'}`); return false; }
      }
    }
    try {
      const placed = await api.post<{ callId: string; dialed: string; prefix: string; target: string; accountId: string }>(`/call-lists/${listId}/items/${item.id}/call`);
      if (placed.accountId !== accountRef.current?.id) {
        api.patch(`/softphone/calls/${placed.callId}`, { status: 'failed', cause: 'Softphone is registered with a different SIP account' }).catch(() => undefined);
        setError('The softphone switched accounts while placing the call. Please press Call again.');
        return false;
      }
      await startCall(placed);
      return true;
    } catch (e) { setError(errText(e, 'Could not place the call')); return false; }
  }, [refresh, startCall]);

  const hangup = useCallback(() => { try { session.current?.terminate(); } catch { /* already ended */ } }, []);
  const answer = useCallback(() => {
    try { session.current?.answer({ mediaConstraints: mediaConstraints(), pcConfig: rtcConfig() }); } catch (e) { setError(errText(e, 'Could not answer')); }
  }, []);
  const mute = useCallback(() => {
    const s = session.current; if (!s) return;
    const m = !callRef.current.muted;
    if (m) s.mute({ audio: true }); else s.unmute({ audio: true });
    setCall((c) => ({ ...c, muted: m }));
  }, []);
  const sendDtmf = useCallback((tone: string) => { try { session.current?.sendDTMF(tone); } catch { /* not connected */ } }, []);

  return { devices, micId, setMicId, speakerId, setSpeakerId, grantMic, sinkSupported, config, account, accountId: account?.id ?? '', setAccountId, reg, regError, call, error, setError, loaded, dial, dialItem, hangup, answer, mute, sendDtmf, refresh, audio };
}
