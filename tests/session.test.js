import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, describeResult, describeSession, money } from '../src/session.js';

const spin = (over = {}) => ({
  win: 0, net: -5, bet: 5, credits: 495, unknown: false, bonus: false, big: false,
  multiplier: 0, ...over,
});

test('money reads naturally out loud in both credit and cash modes', () => {
  assert.equal(money(1, false), '1 credit');
  assert.equal(money(40, false), '40 credits');
  assert.equal(money(12.5, true), '$12.50');
  assert.equal(money(null, false), 'unknown');
});

test('the tracker totals wagers, wins and net position', () => {
  const s = new SessionTracker({ now: () => 0 });
  s.start(500);
  s.record(spin({ win: 0, credits: 495 }));
  s.record(spin({ win: 40, net: 35, credits: 535 }));
  s.record(spin({ win: 0, credits: 530 }));

  const sum = s.summary();
  assert.equal(sum.spins, 3);
  assert.equal(sum.wins, 1);
  assert.equal(sum.losses, 2);
  assert.equal(sum.wagered, 15);
  assert.equal(sum.won, 40);
  assert.equal(sum.credits, 530);
  assert.equal(sum.net, 30, 'net comes from real credit movement');
  assert.equal(sum.biggestWin, 40);
});

test('unreadable spins are counted separately, not scored as losses', () => {
  const s = new SessionTracker({ now: () => 0 });
  s.start(500);
  s.record(spin({ unknown: true, win: null }));
  const sum = s.summary();
  assert.equal(sum.unreadable, 1);
  assert.equal(sum.losses, 0);
  assert.equal(sum.wins, 0);
});

test('the loss limit speaks up once and only once', () => {
  const s = new SessionTracker({ lossLimit: 20, now: () => 0 });
  s.start(100);
  assert.deepEqual(s.record(spin({ credits: 90 })), []);
  const alerts = s.record(spin({ credits: 75 }));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'loss');
  assert.equal(alerts[0].amount, 25);
  assert.deepEqual(s.record(spin({ credits: 60 })), [], 'it must not nag every spin');
});

test('the win goal and the time limit each fire on their own', () => {
  let now = 0;
  const s = new SessionTracker({ winGoal: 50, timeLimitMin: 30, now: () => now });
  s.start(100);
  const winAlerts = s.record(spin({ win: 60, net: 55, credits: 155 }));
  assert.deepEqual(winAlerts.map((a) => a.type), ['win']);

  now = 31 * 60000;
  const timeAlerts = s.record(spin({ credits: 150 }));
  assert.deepEqual(timeAlerts.map((a) => a.type), ['time']);
});

test('hit rate ignores spins that could not be read', () => {
  const s = new SessionTracker({ now: () => 0 });
  s.start(100);
  s.record(spin({ win: 10, net: 5, credits: 105 }));
  s.record(spin({ credits: 100 }));
  s.record(spin({ unknown: true, win: null, credits: 95 }));
  assert.equal(s.hitRate, 0.5);
});

test('a win is announced with the amount, the multiple and the balance', () => {
  const text = describeResult(
    spin({ win: 40, net: 35, credits: 535, multiplier: 8 }), { cash: false }
  );
  assert.match(text, /^Win\./);
  assert.match(text, /40 credits/);
  assert.match(text, /8 times your bet/);
  assert.match(text, /Balance 535 credits/);
});

test('a big win leads with the words that matter', () => {
  const text = describeResult(
    spin({ win: 500, net: 495, credits: 995, multiplier: 100, big: true }), {}
  );
  assert.match(text, /^Big win!/);
});

test('losing spins can be made silent for players who find them tiring', () => {
  const loud = describeResult(spin(), { announceLosses: true });
  assert.match(loud, /No win/);
  const quiet = describeResult(spin(), { announceLosses: false });
  assert.doesNotMatch(quiet, /No win/);
  assert.match(quiet, /Balance/, 'the balance is still worth hearing');
});

test('an unreadable spin says so plainly instead of inventing a result', () => {
  const text = describeResult(spin({ unknown: true, win: null }), {});
  assert.match(text, /could not read/i);
  assert.doesNotMatch(text, /\bwin\b/i);
});

test('the session summary states the direction in plain words', () => {
  const s = new SessionTracker({ now: () => 0 });
  s.start(500);
  s.record(spin({ credits: 495 }));
  const down = describeSession(s.summary(), false);
  assert.match(down, /you're down 5 credits/i);

  const s2 = new SessionTracker({ now: () => 0 });
  s2.start(500);
  s2.record(spin({ win: 100, net: 95, credits: 595 }));
  assert.match(describeSession(s2.summary(), false), /you're up 95 credits/i);
});

test('a session with no movement is described as even, not as a loss', () => {
  const s = new SessionTracker({ now: () => 0 });
  s.start(500);
  s.record(spin({ win: 5, net: 0, credits: 500 }));
  assert.match(describeSession(s.summary(), false), /you're even/i);
});

test('a tracker survives being saved and restored', () => {
  const s = new SessionTracker({ lossLimit: 20, now: () => 0 });
  s.start(100);
  s.record(spin({ credits: 75 }));
  const revived = SessionTracker.fromJSON(JSON.parse(JSON.stringify(s)), { lossLimit: 20, now: () => 0 });
  assert.equal(revived.summary().spins, 1);
  assert.deepEqual(revived.checkLimits(), [], 'an already-fired alert stays fired');
});

test('a balance first seen after play began is not used as the baseline', () => {
  // The app could not read the meters until after the first spin, so the
  // first balance it sees is already one bet short. Reporting that as the
  // starting point would turn a losing session into "you're even".
  const s = new SessionTracker({ now: () => 0 });
  s.start(null);
  s.record(spin({ win: 0, bet: 5, credits: 495 }));
  assert.equal(s.summary().net, -5);
  assert.match(describeSession(s.summary(), false), /you're down 5 credits/i);
});

test('a balance read before the first spin is used as the baseline', () => {
  const s = new SessionTracker({ now: () => 0 });
  s.start(null);
  s.setCredits(500);                     // a clean read while still idle
  s.record(spin({ win: 0, bet: 5, credits: 495 }));
  assert.equal(s.stats.startCreditsTrusted, true);
  assert.equal(s.summary().net, -5);
});

test('credit movement outranks scored spins once the baseline is trusted', () => {
  // A hand pay or a ticket in moves the balance without any spin scoring it.
  const s = new SessionTracker({ now: () => 0 });
  s.start(100);
  s.record(spin({ win: 0, bet: 5, credits: 95 }));
  s.setCredits(300);
  assert.equal(s.summary().net, 200);
});

test('a balance first read after the reels started is not the baseline', () => {
  // The app only got a clean read once the spin was already under way, so the
  // number it sees is post-wager. Treating it as the starting balance would
  // report a losing session as breaking even.
  const s = new SessionTracker({ now: () => 0 });
  s.start(null);
  s.noteSpinStart();
  s.setCredits(495);
  s.record(spin({ win: 0, bet: 5, credits: 495 }));
  assert.equal(s.stats.startCreditsTrusted, false);
  assert.equal(s.summary().net, -5);
  assert.match(describeSession(s.summary(), false), /you're down 5 credits/i);
});

test('recording a spin before the session was started still counts it', () => {
  // start() replaces the stats object, so a stale reference used to send
  // every total to an orphaned object and report zero spins.
  const s = new SessionTracker({ now: () => 0 });
  s.record(spin({ win: 20, net: 15, bet: 5, credits: 515 }));
  const sum = s.summary();
  assert.equal(sum.spins, 1);
  assert.equal(sum.wagered, 5);
  assert.equal(sum.won, 20);
  assert.equal(sum.net, 15, 'falls back to scored spins, not a post-wager baseline');
});
