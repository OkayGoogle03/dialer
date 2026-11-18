import { BadRequestException, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

export interface ProbeResult {
  ok: boolean | null; // null = cannot be determined by this probe (e.g. UDP)
  message: string;
  latencyMs?: number;
}

const isBlocked = (ip: string) =>
  /^169\.254\./.test(ip) || ip === '0.0.0.0' || ip === '::' || /^fe[89ab][0-9a-f]:/i.test(ip) || /^::ffff:169\.254\./i.test(ip);

/**
 * Network probes used by "Test connectivity" actions. Targets are admin-configured, so private ranges are allowed
 * (Asterisk usually lives in a private network); link-local / cloud-metadata addresses are always refused (SSRF).
 * Replaceable in tests via the Nest DI container.
 */
@Injectable()
export class ConnectivityService {
  async assertSafeHost(host: string): Promise<void> {
    const addrs = await lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new BadRequestException(`Host "${host}" does not resolve`);
    if (addrs.some((a) => isBlocked(a.address))) throw new BadRequestException('Target address is not allowed');
  }

  async probeTcp(host: string, port: number, useTls: boolean, timeoutMs = 5000): Promise<ProbeResult> {
    await this.assertSafeHost(host);
    const started = Date.now();
    return new Promise<ProbeResult>((resolve) => {
      const done = (ok: boolean, message: string) => {
        socket.destroy();
        resolve({ ok, message, latencyMs: Date.now() - started });
      };
      // Reachability + handshake only; certificate trust is not evaluated here.
      const socket: net.Socket = useTls
        ? tls.connect({ host, port, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host }, () => done(true, 'TLS handshake succeeded'))
        : net.connect({ host, port }, () => done(true, 'TCP connection succeeded'));
      socket.setTimeout(timeoutMs, () => done(false, 'Connection timed out'));
      socket.on('error', (e: NodeJS.ErrnoException) => done(false, `Connection failed (${e.code ?? 'error'})`));
    });
  }

  /** ARI health check: GET {ariUrl}/asterisk/info with HTTP basic auth. */
  async probeAri(ariUrl: string, username: string, password: string, timeoutMs = 5000): Promise<ProbeResult> {
    let url: URL;
    try {
      url = new URL(ariUrl.replace(/\/+$/, '') + '/asterisk/info');
    } catch {
      return { ok: false, message: 'ARI URL is invalid' };
    }
    await this.assertSafeHost(url.hostname);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      const latencyMs = Date.now() - started;
      if (res.ok) return { ok: true, message: 'ARI responded', latencyMs };
      if (res.status === 401 || res.status === 403) return { ok: false, message: 'ARI rejected the credentials', latencyMs };
      return { ok: false, message: `ARI returned HTTP ${res.status}`, latencyMs };
    } catch (e) {
      const name = (e as Error).name;
      return { ok: false, message: name === 'TimeoutError' ? 'Connection timed out' : 'Connection failed' };
    }
  }
}
