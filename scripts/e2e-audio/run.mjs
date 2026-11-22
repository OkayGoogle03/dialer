import { Agent, sleep } from './harness.mjs';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const only = process.argv[2] || 'all';
const THRESH = 800; // int16 amplitude of the sent tone is 8000; require a clear peak

(async () => {
  const A = new Agent(process.env.A_EXT || '4101', process.env.A_PW || process.env.PW4101, 440);
  const B = new Agent(process.env.B_EXT || '4102', process.env.B_PW || process.env.PW4102, 880);
  try {
    await A.register(); check(`${A.ext} registers over WSS`, true);
    await B.register(); check(`${B.ext} registers over WSS`, true);
  } catch (e) { check('registration', false, e.message); process.exit(1); }

  if (only === 'all' || only === 'p2p') {
    // 1) agent to agent: A sends 440 Hz, B sends 880 Hz; each must HEAR the other's tone and not its own
    A.call(process.env.B_EXT || '4102'); await sleep(7000);
    const now = Date.now();
    const a = A.measure([440, 880], now - 4000, now), b = B.measure([440, 880], now - 4000, now);
    console.log('   A events:', A.events.slice(-6).join(' | ')); console.log('   B events:', B.events.slice(-6).join(' | '));
    check(`${A.ext} -> ${B.ext} call answered (accepted)`, A.events.some((e) => e.includes('accepted')));
    check('B hears A (440 Hz)', b.amps[440] > THRESH && b.amps[440] > 4 * b.amps[880], `B received frames=${b.frames} 440=${b.amps[440]} 880=${b.amps[880]}`);
    check('A hears B (880 Hz)', a.amps[880] > THRESH && a.amps[880] > 4 * a.amps[440], `A received frames=${a.frames} 440=${a.amps[440]} 880=${a.amps[880]}`);
    A.session.terminate(); await sleep(1500);
    check('hang-up ends the call on both sides', !!(A.endInfo && A.endInfo.ended) && !!(B.endInfo && B.endInfo.ended || (B.session && B.session.isEnded())), JSON.stringify(A.endInfo));
  }

  if (only === 'all' || only === 'sim') {
    // 2) simulated provider: answers, plays hello-world, then ECHOES what it receives -> our 440 Hz must come back
    A.events = []; A.call('918889083531'); await sleep(14000);
    const now = Date.now(); const e = A.measure([440, 880], now - 4000, now);
    console.log('   A events:', A.events.join(' | '));
    check('simulated number answers', A.events.some((x) => x.includes('accepted')));
    check('echo returns our tone (440 Hz)', e.amps[440] > THRESH, `A received frames=${e.frames} 440=${e.amps[440]}`);
    A.session.terminate(); await sleep(1500);

    for (const [num, label, expectCode] of [['918889080000', 'busy number', 486], ['8889083533', 'number without 91 is refused', 403], ['12345', 'short number is refused', 403]]) {
      A.events = []; A.call(num); await sleep(3500);
      const code = A.endInfo && A.endInfo.code;
      check(`${label} (${num}) -> SIP ${expectCode}`, code === expectCode, `got ${code} ${A.endInfo && A.endInfo.cause}`);
    }
    A.events = []; A.call('918889089999'); await sleep(6000);
    const ringing = A.events.some((x) => /progress 18[03]/.test(x)); const answered = A.events.some((x) => x.includes('accepted'));
    check('no-answer number (…9999) rings and is not answered', ringing && !answered, A.events.join(' | '));
    A.session.terminate(); await sleep(1200);
  }

  await A.stop(); await B.stop();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
