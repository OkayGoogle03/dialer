#!/usr/bin/env node
// Registers a PBX in the Dialer through its API (no clicking): creates the call server, activates it, and adds SIP accounts for existing users.
//
//   DIALER_URL=https://your-dialer.vercel.app TENANT=demo ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD=... \
//   node scripts/dialer-add-pbx.mjs --host pbx.example.org [--name "Production PBX"] [--port 8089] [--path /ws] \
//        --account agent1@example.org:4001:<sip password> --account agent2@example.org:4002:<sip password> [--dry-run]
//
// The admin password and the SIP passwords come from the environment / arguments of THIS process only; nothing is printed or written.
// Prefer reading the SIP passwords from .deploy/agents.env (written by ops/pbx-new/deploy-remote.sh):  --accounts-file .deploy/agents.env  with
// lines SIP_<ext>=<password> plus --user <ext>=<user email> (repeatable) to say which Dialer user owns which extension.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const all = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const dry = args.includes('--dry-run');
const base = (process.env.DIALER_URL || '').replace(/\/$/, '');
const { TENANT, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
const host = opt('--host');
if (!base || !TENANT || !ADMIN_EMAIL || !ADMIN_PASSWORD || !host) { console.error('need DIALER_URL, TENANT, ADMIN_EMAIL, ADMIN_PASSWORD and --host (see the header of this file)'); process.exit(2); }

let accounts = all('--account').map((s) => { const [email, sipId, ...pw] = s.split(':'); return { email, sipId, password: pw.join(':') }; });
const file = opt('--accounts-file');
if (file) {
  const pws = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => /^SIP_\d+=/.test(l)).map((l) => [l.slice(4, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  for (const m of all('--user')) { const [ext, email] = m.split('='); if (pws[ext]) accounts.push({ email, sipId: ext, password: pws[ext] }); else console.error(`no password for ${ext} in ${file}`); }
}

const call = async (method, path, body, token) => {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.message ? JSON.stringify(json.message) : text.slice(0, 160)}`);
  return json;
};

if (dry) { console.log(`DRY-RUN: sign in to ${base} as ${ADMIN_EMAIL} (tenant ${TENANT}); create + activate call server ${host}:${opt('--port', '8089')}${opt('--path', '/ws')} (WSS); add ${accounts.length} SIP account(s): ${accounts.map((a) => `${a.sipId}->${a.email}`).join(', ')}`); process.exit(0); }

const login = await call('POST', '/auth/login', { tenant: TENANT, email: ADMIN_EMAIL, password: ADMIN_PASSWORD, refreshTokenDelivery: 'body' });
const token = login.accessToken;
const servers = (await call('GET', '/call-servers?limit=100', null, token)).items ?? [];
let server = servers.find((s) => s.host === host && s.sipTransport === 'wss');
if (server) console.log(`call server ${host} already exists (${server.id}); reusing it`);
else {
  server = await call('POST', '/call-servers', { name: opt('--name', host), host, port: Number(opt('--port', '8089')), sipTransport: 'wss', sipWsPath: opt('--path', '/ws') }, token);
  console.log(`created call server ${server.id}`);
}
if (server.status !== 'active') { await call('PUT', `/call-servers/${server.id}`, { status: 'active' }, token); console.log('call server activated'); }

const users = (await call('GET', '/users?limit=200', null, token)).items ?? [];
for (const a of accounts) {
  const u = users.find((x) => x.email === a.email);
  if (!u) { console.error(`user ${a.email} not found: create the user first`); continue; }
  try { await call('POST', '/softphone-accounts', { userId: u.id, callServerId: server.id, sipId: a.sipId, password: a.password }, token); console.log(`SIP account ${a.sipId} added for ${a.email}`); }
  catch (e) { console.error(`SIP account ${a.sipId}: ${e.message}`); }
}
console.log('done. Agents see the new address on their next softphone refresh.');
