import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { errText } from '../components/kit';
import { isNativeTransport, nativeAvailable, startNative } from './nativeEngine';

export interface SoftphoneAccount {
  id: string; sipId: string; displayName: string | null; password: string;
  callServer: { id: string; name: string; host: string | null; port: number | null; transport: string; wsPath: string; realm: string | null; webrtcUrl: string | null; addressUpdatedAt: string | null };
}
export interface DialOption { assignmentId: string; processId: string; processName: string; prefix: string; callServerId: string }
export interface SoftphoneConfig { accounts: SoftphoneAccount[]; dialOptions: DialOption[]; fetchedAt: string; ringTimeoutSeconds?: number }

export type RegState = 'idle' | 'connecting' | 'registered' | 'failed' | 'unavailable';
export type CallState = 'idle' | 'dialing' | 'ringing' | 'in_call' | 'incoming';
export interface ActiveCall { state: CallState; number: string; direction: 'out' | 'in'; startedAt: number | null; muted: boolean; callId: string | null; note: string | null }

const IDLE_CALL: ActiveCall = { state: 'idle', number: '', direction: 'out', startedAt: null, muted: false, callId: null, note: null };
/** Agents pick up an admin's IP change within this time even if the connection never drops. */
const REFETCH_MS = 5 * 60_000;
const RETRY_MS = 30_000;

/** Identity of everything that needs a new SIP UA when it changes (address, credentials). */
export const uaKey = (a: SoftphoneAccount | undefined) => (a ? [a.id, a.sipId, a.password, a.callServer.webrtcUrl, a.callServer.realm].join('|') : '');

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
  const audio = useRef<HTMLAudioElement | null>(null);
  const accountRef = useRef<SoftphoneAccount | undefined>(undefined);
  const configRef = useRef<SoftphoneConfig | null>(null);
  configRef.current = config;
  const callRef = useRef(call);
  callRef.current = call;

  const account = config?.accounts.find((a) => a.id === accountId) ?? config?.accounts[0];
  accountRef.current = account;

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

  const wireSession = useCallback((s: any, base: ActiveCall) => {
    session.current = s;
    setCall(base);
    // Maximum ringing time at the called party (server setting, default 5 s): after that the call is cancelled and recorded as not answered.
    const ringMs = Math.max(1, configRef.current?.ringTimeoutSeconds ?? 5) * 1000;
    let ringTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const clearRing = () => { if (ringTimer) { clearTimeout(ringTimer); ringTimer = null; } };
    const timeoutCause = `No answer within ${ringMs / 1000} s (ring limit)`;
    s.on('progress', () => {
      setCall((c) => ({ ...c, state: 'ringing' })); track(base.callId, 'ringing');
      if (base.direction === 'out' && !ringTimer && !timedOut) ringTimer = setTimeout(() => { timedOut = true; try { s.terminate(); } catch { /* already ended */ } }, ringMs);
    });
    s.on('accepted', () => {
      clearRing();
      setCall((c) => ({ ...c, state: 'in_call', startedAt: Date.now() }));
      track(base.callId, 'answered');
    });
    s.on('peerconnection', (e: any) => {
      e.peerconnection.ontrack = (ev: RTCTrackEvent) => {
        if (audio.current && ev.streams[0]) { audio.current.srcObject = ev.streams[0]; void audio.current.play().catch(() => undefined); }
      };
    });
    s.on('failed', (e: any) => {
      clearRing();
      if (timedOut) { track(base.callId, 'completed', { cause: timeoutCause }); setCall({ ...IDLE_CALL, note: timeoutCause + ' - call disconnected' }); session.current = null; return; }
      const code = e?.message?.status_code as number | undefined;
      const phrase = e?.message?.reason_phrase as string | undefined;
      track(base.callId, 'failed', { cause: `${e?.cause ?? 'failed'}${phrase && !String(e?.cause ?? '').includes(phrase) ? ` - ${phrase}` : ''}`.slice(0, 100), ...(code ? { sipCode: code } : {}) });
      setCall({ ...IDLE_CALL, note: `Call failed: ${e?.cause ?? 'unknown'}${code ? ` (${code})` : ''}` });
      session.current = null;
    });
    s.on('ended', (e: any) => {
      clearRing();
      if (timedOut) { track(base.callId, 'completed', { cause: timeoutCause }); setCall({ ...IDLE_CALL, note: timeoutCause + ' - call disconnected' }); session.current = null; return; }
      track(base.callId, 'completed', { cause: String(e?.cause ?? 'normal').slice(0, 100) }); finishCall();
    });
  }, [finishCall, track]);

  const startUa = useCallback(async (acct: SoftphoneAccount) => {
    stopUa();
    if (isNativeTransport(acct.callServer.transport)) {
      if (!nativeAvailable()) { setReg('unavailable'); setRegError(`This call server uses ${acct.callServer.transport.toUpperCase()} SIP, which a browser cannot do. Install the Windows desktop app (sidebar: Download App) and sign in there.`); return; }
      setReg('connecting'); setRegError(null);
      const key = uaKey(acct);
      keyRef.current = key;
      try {
        const native = await startNative({ host: acct.callServer.host ?? '', port: acct.callServer.port ?? (acct.callServer.transport === 'tcp' ? 5060 : 5060), transport: acct.callServer.transport, sipId: acct.sipId, password: acct.password, realm: acct.callServer.realm, displayName: acct.displayName }, {
          onRegistered: () => { if (keyRef.current !== key) return; setReg('registered'); setRegError(null); report(acct.id, 'registered'); },
          onFailed: (m) => { if (keyRef.current !== key) return; setReg('failed'); setRegError(`Registration failed: ${m}`); report(acct.id, 'failed', m); },
          onDisconnected: () => { if (keyRef.current !== key) return; setReg('failed'); setRegError('Connection to the call server was lost.'); report(acct.id, 'failed', 'connection lost'); },
          onIncoming: (s, from) => { if (session.current) { s.terminate(); return; } wireSession(s, { ...IDLE_CALL, state: 'incoming', direction: 'in', number: from }); },
        });
        ua.current = { call: native.call, stop: native.stop };
      } catch (e) { setReg('failed'); setRegError(`Could not start the desktop SIP engine: ${e instanceof Error ? e.message : 'error'}`); }
      return;
    }
    if (!acct.callServer.webrtcUrl) { setReg('unavailable'); setRegError('This call server is configured with a transport the browser cannot use (needs WSS/WS).'); return; }
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
      const msg = `Registration rejected${e?.response?.status_code ? ` (${e.response.status_code} ${e.response.reason_phrase ?? ''})` : ''}`.trim();
      setReg('failed'); setRegError(msg); report(acct.id, 'failed', msg);
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
      if (!a) { stopUa(); setReg('idle'); return; }
      if (uaKey(a) !== keyRef.current && !callRef.current.callId) await startUa(a); // never tear down a live call
    } catch (e) { setError(errText(e, 'Could not load softphone settings')); }
    finally { setLoaded(true); }
  }, [startUa, stopUa]);

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
    if (reg !== 'failed') return;
    const t = setInterval(() => { keyRef.current = ''; void refresh(); }, RETRY_MS);
    return () => clearInterval(t);
  }, [reg, refresh]);

  // switching account
  useEffect(() => { if (account && uaKey(account) !== keyRef.current && !callRef.current.callId) void startUa(account); }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Dials what the server returned (prefix already applied) and wires the call events. */
  const startCall = useCallback(async (placed: { callId: string; dialed: string; prefix: string; target: string }) => {
    const s = await ua.current.call(placed.target, { mediaConstraints: { audio: true, video: false }, rtcOfferConstraints: { offerToReceiveAudio: true }, pcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } });
    wireSession(s, { ...IDLE_CALL, state: 'dialing', number: placed.dialed, callId: placed.callId, note: placed.prefix ? `Prefix ${placed.prefix} applied` : null });
  }, [wireSession]);

  const dial = useCallback(async (destination: string, assignmentId?: string) => {
    const acct = accountRef.current;
    if (!acct || !ua.current || reg !== 'registered') { setError('Not registered with the call server yet.'); return; }
    setError(null);
    try {
      const placed = await api.post<{ callId: string; dialed: string; prefix: string; target: string }>('/softphone/calls', { accountId: acct.id, destination, ...(assignmentId ? { assignmentId } : {}) });
      await startCall(placed);
    } catch (e) { setError(errText(e, 'Could not place the call')); }
  }, [reg, startCall]);

  /** Dials one row of an Excel call list (its own prefix / call server). */
  const dialItem = useCallback(async (listId: string, itemId: string): Promise<boolean> => {
    if (!ua.current || reg !== 'registered' || callRef.current.state !== 'idle') { setError('Not registered with the call server yet, or a call is in progress.'); return false; }
    setError(null);
    try {
      const placed = await api.post<{ callId: string; dialed: string; prefix: string; target: string; accountId: string }>(`/call-lists/${listId}/items/${itemId}/call`);
      if (placed.accountId !== accountRef.current?.id) {
        api.patch(`/softphone/calls/${placed.callId}`, { status: 'failed', cause: 'Softphone is registered with a different SIP account' }).catch(() => undefined);
        setError('This row belongs to a different SIP account than the one registered. Select that account first.');
        return false;
      }
      await startCall(placed);
      return true;
    } catch (e) { setError(errText(e, 'Could not place the call')); return false; }
  }, [reg, startCall]);

  const hangup = useCallback(() => { try { session.current?.terminate(); } catch { /* already ended */ } }, []);
  const answer = useCallback(() => {
    try { session.current?.answer({ mediaConstraints: { audio: true, video: false } }); } catch (e) { setError(errText(e, 'Could not answer')); }
  }, []);
  const mute = useCallback(() => {
    const s = session.current; if (!s) return;
    const m = !callRef.current.muted;
    if (m) s.mute({ audio: true }); else s.unmute({ audio: true });
    setCall((c) => ({ ...c, muted: m }));
  }, []);
  const sendDtmf = useCallback((tone: string) => { try { session.current?.sendDTMF(tone); } catch { /* not connected */ } }, []);

  return { config, account, accountId: account?.id ?? '', setAccountId, reg, regError, call, error, setError, loaded, dial, dialItem, hangup, answer, mute, sendDtmf, refresh, audio };
}
