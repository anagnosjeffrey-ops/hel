import test from 'node:test';
import assert from 'node:assert/strict';
import { SpinEngine, STATE } from '../src/engine.js';

/** Collect every event an engine emits. */
function makeEngine(opts = {}) {
  const events = [];
  const engine = new SpinEngine(opts, (name, payload) => events.push({ name, payload }));
  return { engine, events, of: (n) => events.filter((e) => e.name === n).map((e) => e.payload) };
}

/** Feed a run of identical samples. Returns the timestamp after the last one. */
function feed(engine, from, to, motion, meters, step = 100) {
  let t = from;
  for (; t <= to; t += step) engine.push({ t, motion, meters });
  return t;
}

const idle = { credits: 500, bet: 5, win: 0 };

test('a winning spin is reported from the change in credits', () => {
  const { engine, of } = makeEngine();
  feed(engine, 0, 400, 0, idle);
  feed(engine, 500, 2000, 0.3, { credits: 495, bet: 5, win: 0 });
  feed(engine, 2100, 3200, 0.0, { credits: 535, bet: 5, win: 0 });

  const results = of('result');
  assert.equal(results.length, 1);
  const r = results[0];
  // Credits went 500 -> 535 across a 5 credit bet, so the machine paid 40.
  assert.equal(r.win, 40);
  assert.equal(r.net, 35);
  assert.equal(r.bet, 5);
  assert.equal(r.credits, 535);
  assert.equal(r.unknown, false);
  assert.equal(r.source, 'credit-delta');
});

test("a losing spin reports a zero win, not a negative one", () => {
  const { engine, of } = makeEngine();
  feed(engine, 0, 400, 0, idle);
  feed(engine, 500, 2000, 0.3, { credits: 495, bet: 5, win: 0 });
  feed(engine, 2100, 3200, 0.0, { credits: 495, bet: 5, win: 0 });

  const r = of('result')[0];
  assert.equal(r.win, 0);
  assert.equal(r.net, -5);
  assert.equal(r.unknown, false);
});

test("the machine's own win meter is trusted over the credit maths", () => {
  const { engine, of } = makeEngine();
  feed(engine, 0, 400, 0, idle);
  feed(engine, 500, 2000, 0.3, { credits: 495, bet: 5, win: 0 });
  // Credits are still mid-animation but the WIN meter already reads 250.
  feed(engine, 2100, 3200, 0.0, { credits: 500, bet: 5, win: 250 });

  const r = of('result')[0];
  assert.equal(r.win, 250);
  assert.equal(r.source, 'win-meter');
});

test('a big win is flagged so it can get its own fanfare', () => {
  const { engine, of } = makeEngine({ bigWinMultiplier: 15 });
  feed(engine, 0, 400, 0, idle);
  feed(engine, 500, 2000, 0.3, { credits: 495, bet: 5, win: 0 });
  feed(engine, 2100, 3200, 0.0, { credits: 895, bet: 5, win: 0 });

  const r = of('result')[0];
  assert.equal(r.win, 400);
  assert.equal(r.multiplier, 80);
  assert.equal(r.big, true);
});

test('a brief flicker does not get announced as a spin', () => {
  const { engine, of } = makeEngine();
  feed(engine, 0, 400, 0, idle);
  // Someone walks past: one 100ms frame of motion, under the 220ms threshold.
  engine.push({ t: 500, motion: 0.4, meters: idle });
  feed(engine, 600, 2000, 0, idle);

  assert.equal(of('spin-start').length, 0);
  assert.equal(of('result').length, 0);
});

test('reels restarting during the settle window stay one spin', () => {
  const { engine, of } = makeEngine();
  feed(engine, 0, 400, 0, idle);
  feed(engine, 500, 1500, 0.3, { credits: 495, bet: 5, win: 0 });
  // Reels stop, pause 300ms, then an anticipation reel spins again.
  feed(engine, 1600, 1900, 0.0, { credits: 495, bet: 5, win: 0 });
  feed(engine, 2000, 3000, 0.3, { credits: 495, bet: 5, win: 0 });
  feed(engine, 3100, 4200, 0.0, { credits: 605, bet: 5, win: 0 });

  assert.equal(of('spin-start').length, 1, 'one spin, not two');
  const results = of('result');
  assert.equal(results.length, 1);
  assert.equal(results[0].win, 110);
});

test('a long spin is treated as a bonus round', () => {
  const { engine, of } = makeEngine();
  feed(engine, 0, 400, 0, idle);
  feed(engine, 500, 14000, 0.3, { credits: 495, bet: 5, win: 0 }, 500);
  feed(engine, 14100, 15200, 0.0, { credits: 700, bet: 5, win: 0 });

  assert.equal(of('result')[0].bonus, true);
});

test('a bonus banner in the on-screen text is picked up', () => {
  const { engine, of } = makeEngine();
  feed(engine, 0, 400, 0, idle);
  feed(engine, 500, 2000, 0.3, { credits: 495, bet: 5, win: 0, text: 'FREE GAMES AWARDED' });
  feed(engine, 2100, 3200, 0.0, { credits: 495, bet: 5, win: 0 });

  assert.equal(of('result')[0].bonus, true);
});

test('an unreadable spin is reported as unknown rather than guessed', () => {
  const { engine, of } = makeEngine();
  feed(engine, 0, 400, 0, {});
  feed(engine, 500, 2000, 0.3, {});
  feed(engine, 2100, 3200, 0.0, {});

  const r = of('result')[0];
  assert.equal(r.unknown, true);
  assert.equal(r.win, null);
});

test('money added or removed while idle is announced', () => {
  const { engine, of } = makeEngine();
  feed(engine, 0, 400, 0, idle);
  feed(engine, 500, 900, 0, { credits: 600, bet: 5, win: 0 });

  const changes = of('balance-change');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].delta, 100);
  assert.equal(changes[0].credits, 600);
});

test('losing sight of the meters raises one alert, and recovery clears it', () => {
  const { engine, of } = makeEngine({ staleReadMs: 3000 });
  feed(engine, 0, 400, 0, idle);
  feed(engine, 500, 6000, 0, {}, 500);
  assert.equal(of('lost-track').length, 1, 'exactly one alert, not one per frame');

  feed(engine, 6500, 7000, 0, idle);
  assert.equal(of('reacquired').length, 1);
});

test('a spin that never ends is abandoned instead of announced', () => {
  const { engine, of } = makeEngine({ maxSpinMs: 2000 });
  feed(engine, 0, 400, 0, idle);
  feed(engine, 500, 5000, 0.5, { credits: 495, bet: 5, win: 0 }, 250);

  assert.equal(of('spin-abandoned').length, 1);
  assert.equal(of('result').length, 0);
  assert.equal(engine.state, STATE.IDLE);
});

test('cash machines keep their decimals intact', () => {
  const { engine, of } = makeEngine();
  const cashIdle = { credits: 40.25, bet: 0.5, win: 0 };
  feed(engine, 0, 400, 0, cashIdle);
  feed(engine, 500, 2000, 0.3, { credits: 39.75, bet: 0.5, win: 0 });
  feed(engine, 2100, 3200, 0.0, { credits: 42.25, bet: 0.5, win: 0 });

  const r = of('result')[0];
  assert.equal(r.win, 2.5);
  assert.equal(r.credits, 42.25);
});
