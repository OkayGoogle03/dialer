'use strict';
// Owns the app's ONE SIP engine and checks every setting the hosted softphone page sends before the engine uses it.
const { SipUa, isValidTarget } = require('./sip-ua');

const HOST_RE = /^(?=.{1,253}$)(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)$/;
const SIP_USER_RE = /^[A-Za-z0-9._@+-]{1,64}$/;
const CLEAN = /^[^\r\n\0]{0,200}$/; // nothing that could start a new SIP header line

/** Turns what the page sent into engine options, or null if anything is unacceptable. */
function engineOptions(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const host = String(cfg.host ?? ''); const sipId = String(cfg.sipId ?? ''); const password = String(cfg.password ?? '');
  const port = Number(cfg.port) || 5060;
  const realm = cfg.realm ? String(cfg.realm) : undefined;
  const displayName = cfg.displayName ? String(cfg.displayName).replace(/"/g, '') : undefined;
  if (!HOST_RE.test(host) || !SIP_USER_RE.test(sipId) || !password || !CLEAN.test(password)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (realm && !HOST_RE.test(realm)) return null;
  if (displayName && !CLEAN.test(displayName)) return null;
  return { server: host, port, transport: cfg.transport === 'tcp' ? 'tcp' : 'udp', sipId, password, realm, displayName };
}

/** A client is { name, event(ev, data), audio(Int16Array) }. */
class SipHost {
  constructor(createUa = (opts) => new SipUa(opts)) { this.createUa = createUa; this.ua = null; this.owner = null; }

  async start(client, cfg) {
    if (this.owner && this.owner !== client) return { ok: false, message: `The softphone on this PC is already in use by ${this.owner.name}. Close it there first.` };
    const opts = engineOptions(cfg);
    if (!opts) return { ok: false, message: 'The call server or SIP account settings are not valid' };
    this.drop();
    const ua = this.createUa(opts);
    this.ua = ua; this.owner = client;
    // Events of a previous (stopped) user agent must never reach the page: they would be blamed on the new account.
    const cur = (fn) => (a) => { if (this.ua === ua) fn(a); };
    ua.on('registered', cur((d) => client.event('registered', d)));
    ua.on('registrationFailed', cur((d) => client.event('registrationFailed', d)));
    ua.on('disconnected', cur(() => client.event('disconnected', {})));
    ua.on('error', cur((e) => client.event('error', { message: String((e && e.message) || e) })));
    ua.on('call', cur((d) => client.event('call', d)));
    ua.on('audio', cur((pcm) => client.audio(pcm)));
    try { await ua.start(); return { ok: true, localIp: ua.localIp }; } catch (e) { if (this.ua === ua) this.stop(client); return { ok: false, message: String((e && e.message) || e) }; }
  }

  drop() { if (this.ua) { const old = this.ua; this.ua = null; try { old.stop(); } catch { /* old agent */ } } }
  /** Ends any call, unregisters and frees the engine. Only its owner can do this. */
  stop(client) { if (this.owner !== client) return; this.drop(); this.owner = null; }
  shutdown() { this.drop(); this.owner = null; }
  engineOf(client) { return this.owner === client ? this.ua : null; }

  async call(client, target) {
    const ua = this.engineOf(client);
    if (!ua) return { ok: false, message: 'Not started' };
    if (!isValidTarget(target)) return { ok: false, message: 'Invalid target' };
    try { await ua.callTo(String(target)); return { ok: true }; } catch (e) { return { ok: false, message: String(e.message || e) }; }
  }
  hangup(client) { this.engineOf(client)?.hangup(); }
  answer(client) { this.engineOf(client)?.answer(); }
  mute(client, m) { this.engineOf(client)?.setMuted(!!m); }
  dtmf(client, d) { this.engineOf(client)?.sendDtmf(String(d).slice(0, 1)); }
  sendAudio(client, pcm) { this.engineOf(client)?.sendAudio(pcm); }
}

module.exports = { SipHost, engineOptions };
