// Outbound call limits of the PBX dial plan, with REAL SIP calls: per-agent and global concurrency, and a caller-ID spoof attempt.
// Needs a PBX configured with MAX_OUTBOUND=2 and MAX_PER_AGENT=1, ALLOW_PREFIXES=91, and a trunk whose far end ANSWERS and holds calls to 9100000000X
// (the clean-room test loops a trunk back into the same PBX). Three agents: EXTS="4201 4202 4203", PWS="pw1 pw2 pw3".
import { Agent, sleep } from './harness.mjs';

const exts = (process.env.EXTS || '').split(' '); const pws = (process.env.PWS || '').split(' ');
if (exts.length !== 3 || pws.length !== 3) { console.error('set EXTS="e1 e2 e3" and PWS="p1 p2 p3"'); process.exit(2); }
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const num = (n) => `9100000000${n}`;
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))]);

const [a, b, c] = exts.map((e, i) => new Agent(e, pws[i], 440 + i * 100));
for (const x of [a, b, c]) await x.register();
console.log(`registered ${exts.join(', ')}`);

const a1 = a.placeCall(num(1));
const r1 = await withTimeout(a1.done, 15000);
check('agent A call #1 to an allowed number is answered', r1.accepted === true, JSON.stringify(r1));

const a2 = a.placeCall(num(2));
const r2 = await withTimeout(a2.done, 15000);
check('agent A call #2 at the same time is refused (per-agent limit) with SIP 503', r2.accepted === false && r2.code === 503, JSON.stringify(r2));

// caller-ID spoof: the From header claims to be agent B
const a3 = a.placeCall(num(3), { fromUser: exts[1] });
const r3 = await withTimeout(a3.done, 15000);
// Asterisk identifies an INVITE by its From user, so a spoofed From is challenged for the OTHER agent's credentials and fails authentication (401) before any
// dial-plan limit runs; the call must in no case be answered, and the limit counting by CHANNEL(endpoint) stays as defence in depth
check('same agent with a SPOOFED From user (claiming to be agent B) is NOT let through (401 authentication failure, or 503 from the limit)', r3.accepted === false && (r3.code === 401 || r3.code === 503), JSON.stringify(r3));

const b1 = b.placeCall(num(4));
const rb = await withTimeout(b1.done, 15000);
check('agent B has its own budget: its call is answered although A is at its limit', rb.accepted === true, JSON.stringify(rb));

const c1 = c.placeCall(num(5));
const rc = await withTimeout(c1.done, 15000);
check('agent C is refused with 503 because the global limit (2 calls at once) is reached', rc.accepted === false && rc.code === 503, JSON.stringify(rc));

a1.session.terminate(); await sleep(2500);
const c2 = c.placeCall(num(6));
const rc2 = await withTimeout(c2.done, 15000);
check('after agent A hangs up a slot is free again: agent C is now answered', rc2.accepted === true, JSON.stringify(rc2));

b1.session.terminate(); c2.session.terminate(); await sleep(1500);
const d1 = a.placeCall('8889083533'); const rd = await withTimeout(d1.done, 15000);
check('a number outside the allow-list is refused with SIP 403', rd.accepted === false && rd.code === 403, JSON.stringify(rd));

for (const x of [a, b, c]) await x.stop();
const bad = results.filter((x) => !x).length;
console.log(`\n${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
