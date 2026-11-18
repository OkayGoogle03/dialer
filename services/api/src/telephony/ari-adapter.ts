import { Injectable } from '@nestjs/common';
import { ConnectivityService } from '../master-data/connectivity.service';
import { OriginateRequest, OriginateResult, ServerEndpoint, TelephonyAdapter } from './telephony-adapter';

const auth = (e: ServerEndpoint) => 'Basic ' + Buffer.from(`${e.ariUsername}:${e.ariPassword}`).toString('base64');
const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET_BEFORE_SEND']);

/**
 * Asterisk ARI over HTTP: POST {ariUrl}/channels?endpoint=...&app=...&callerId=...&channelId=...
 * The channel then runs inside the Stasis application (telephony-adapter service, Phase 2) which owns call-state events.
 * NOTE: request shape is tested against a local stub only; it has not been exercised against a live Asterisk.
 */
@Injectable()
export class AriTelephonyAdapter extends TelephonyAdapter {
  constructor(private readonly probes: ConnectivityService, private readonly timeoutMs = 10_000) {
    super();
  }

  async originate(req: OriginateRequest): Promise<OriginateResult> {
    let url: URL;
    try {
      url = new URL(req.ariUrl.replace(/\/+$/, '') + '/channels');
      await this.probes.assertSafeHost(url.hostname);
    } catch {
      return { ok: false, code: 'ari_target_invalid', retryable: true, uncertain: false };
    }
    url.search = new URLSearchParams({ endpoint: req.endpoint, app: req.appName, callerId: req.callerId, channelId: req.callId }).toString();
    try {
      const res = await fetch(url, { method: 'POST', headers: { Authorization: auth(req) }, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { id?: string };
        return { ok: true, channelId: body.id ?? req.callId };
      }
      // 5xx: the PBX itself is unhealthy, another server/trunk may work. 4xx: our request/credentials are wrong; retrying elsewhere would repeat it.
      if (res.status >= 500) return { ok: false, code: 'ari_unavailable', sipCode: res.status, retryable: true, uncertain: false };
      return { ok: false, code: res.status === 401 || res.status === 403 ? 'ari_auth_failed' : 'ari_rejected', sipCode: res.status, retryable: false, uncertain: false };
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code ?? '';
      if (CONNECT_ERRORS.has(cause)) return { ok: false, code: 'ari_unreachable', retryable: true, uncertain: false };
      // Timeout or reset after the request may have been sent: the call might exist. Do not retry.
      return { ok: false, code: 'ari_timeout', retryable: false, uncertain: true };
    }
  }

  async hangup(req: ServerEndpoint & { channelId: string }): Promise<void> {
    const url = new URL(req.ariUrl.replace(/\/+$/, '') + `/channels/${encodeURIComponent(req.channelId)}`);
    await this.probes.assertSafeHost(url.hostname);
    const res = await fetch(url, { method: 'DELETE', headers: { Authorization: auth(req) }, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    if (!res.ok && res.status !== 404) throw new Error(`ARI hangup failed (HTTP ${res.status})`);
  }
}
