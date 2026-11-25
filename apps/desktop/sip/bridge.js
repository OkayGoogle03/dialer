'use strict';
// Local bridge: lets the Dialer web page, open in a normal browser on THIS PC, use the app's UDP/TCP SIP engine.
// A WebSocket server on 127.0.0.1 only (nothing is reachable from the network). Any website a browser visits can try to connect to
// 127.0.0.1, so every connection must pass: loopback peer, a local Host header (stops DNS rebinding), and an Origin that the user of
// this PC approved. The app stores no SIP password: the signed-in page sends its own account when it starts.
const http = require('node:http');
const { WebSocketServer } = require('ws');

const BRIDGE_PORT = 17654;
const BRIDGE_PATH = '/dialer-bridge';
const PROTOCOL = 1;

/** The origin as the browser sends it, if it is one that may ever be approved: https, or http on this PC (development). */
function cleanOrigin(value) {
  try {
    const u = new URL(String(value));
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.origin !== value) return null;
    return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? u.origin : null;
  } catch { return null; }
}

/** opts: { host: SipHost, isAllowed(origin) => Promise<boolean>, port? }. Resolves with { port, close() } once listening. */
function startBridge({ host, isAllowed, port = BRIDGE_PORT }) {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  let actualPort = port;

  const refuse = (socket, status) => { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };

  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => undefined);
    const peer = socket.remoteAddress;
    if (peer !== '127.0.0.1' && peer !== '::ffff:127.0.0.1') return refuse(socket, '403 Forbidden');
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host)) return refuse(socket, '403 Forbidden');
    if (req.url !== BRIDGE_PATH) return refuse(socket, '404 Not Found');
    const origin = cleanOrigin(req.headers.origin);
    if (!origin) return refuse(socket, '403 Forbidden');
    let ok = false;
    try { ok = await isAllowed(origin); } catch { ok = false; }
    if (!ok) return refuse(socket, '403 Forbidden');
    if (socket.destroyed) return;
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws));
  });

  function serve(ws) {
    const send = (data, opts) => { if (ws.readyState === ws.OPEN) ws.send(data, opts); };
    const client = {
      name: 'a web browser tab',
      event: (ev, data) => send(JSON.stringify({ ev, data })),
      audio: (pcm) => send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), { binary: true }),
    };
    const ops = {
      hello: () => ({ ok: true, protocol: PROTOCOL }),
      start: (arg) => host.start(client, arg),
      stop: () => { host.stop(client); return { ok: true }; },
      call: (arg) => host.call(client, arg),
      hangup: () => { host.hangup(client); return { ok: true }; },
      answer: () => { host.answer(client); return { ok: true }; },
      mute: (arg) => { host.mute(client, arg); return { ok: true }; },
      dtmf: (arg) => { host.dtmf(client, arg); return { ok: true }; },
    };
    ws.on('message', async (data, isBinary) => {
      if (isBinary) { // microphone: 8 kHz mono PCM16
        if (data.length < 2 || data.length % 2) return;
        const pcm = new Int16Array(data.length / 2);
        for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2);
        return host.sendAudio(client, pcm);
      }
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || !Object.hasOwn(ops, msg.op)) return;
      let result; try { result = await ops[msg.op](msg.arg); } catch (e) { result = { ok: false, message: String((e && e.message) || e) }; }
      send(JSON.stringify({ id: msg.id, result }));
    });
    // Browser tab closed or reloaded: end the call and unregister, and free the engine for the next tab.
    ws.on('close', () => host.stop(client));
    ws.on('error', () => undefined);
    // A frozen or vanished page must not keep the engine: drop connections that stop answering pings.
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  }

  const pinger = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  }, 20_000);

  return new Promise((resolve, reject) => {
    server.once('error', (e) => { clearInterval(pinger); reject(e); });
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port;
      resolve({ port: actualPort, close: () => { clearInterval(pinger); for (const ws of wss.clients) ws.terminate(); server.close(); } });
    });
  });
}

module.exports = { startBridge, cleanOrigin, BRIDGE_PORT, BRIDGE_PATH };
