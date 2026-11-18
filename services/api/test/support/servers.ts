import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { OriginateRequest, OriginateResult, ServerEndpoint, TelephonyAdapter } from '../../src/telephony/telephony-adapter';

/** Local TCP listener standing in for a SIP trunk host (reachability test only). */
export async function startTcp() {
  const server = net.createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Local stub of the Asterisk ARI HTTP API: basic auth on /ari/asterisk/info, POST /ari/channels, DELETE /ari/channels/:id. */
export async function startAri(creds: { username: string; password: string }) {
  const requests: { method: string; url: string }[] = [];
  const expected = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' });
    if (req.headers.authorization !== expected) { res.writeHead(401).end(); return; }
    if (req.url?.startsWith('/ari/asterisk/info')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"build":{}}'); return; }
    if (req.method === 'POST' && req.url?.startsWith('/ari/channels')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: new URL(req.url, 'http://x').searchParams.get('channelId') })); return; }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/ari`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Scripted telephony adapter: records every originate/hangup and returns whatever the script decides. */
export class MockTelephony extends TelephonyAdapter {
  originated: OriginateRequest[] = [];
  hungUp: string[] = [];
  script: (req: OriginateRequest, n: number) => OriginateResult | Promise<OriginateResult> = (req) => ({ ok: true, channelId: req.callId });
  async originate(req: OriginateRequest) {
    this.originated.push(req);
    return this.script(req, this.originated.length);
  }
  async hangup(req: ServerEndpoint & { channelId: string }) {
    this.hungUp.push(req.channelId);
  }
}
