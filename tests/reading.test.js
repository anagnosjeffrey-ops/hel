import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, readMeters, Stabilizer, pairScore, normalizeWords } from '../src/reading.js';

/** Build a Tesseract-shaped word. */
const word = (text, x, y, w = 120, h = 40) => ({
  text,
  confidence: 90,
  bbox: { x0: x, y0: y, x1: x + w, y1: y + h },
});

test('parseNumber handles the formats slot displays actually use', () => {
  assert.deepEqual(parseNumber('1234'), { value: 1234, cash: false });
  assert.deepEqual(parseNumber('1,234'), { value: 1234, cash: false });
  assert.deepEqual(parseNumber('$12.34'), { value: 12.34, cash: true });
  assert.deepEqual(parseNumber('12.34'), { value: 12.34, cash: true });
  assert.deepEqual(parseNumber('0.40'), { value: 0.4, cash: true });
  assert.deepEqual(parseNumber('1,234.56'), { value: 1234.56, cash: true });
  assert.equal(parseNumber('1.5').value, 1.5);
  assert.equal(parseNumber('1.5').cash, false);
});

test('parseNumber repairs the characters OCR gets wrong on slot fonts', () => {
  // O/0, l/1, S/5 are the classic seven-segment confusions.
  assert.equal(parseNumber('1O0').value, 100);
  assert.equal(parseNumber('l5').value, 15);
  assert.equal(parseNumber('S0').value, 50);
});

test('parseNumber rejects things that are not numbers', () => {
  assert.equal(parseNumber('CREDIT'), null);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber(null), null);
  assert.equal(parseNumber('--'), null);
});

test('readMeters finds each meter by its printed label', () => {
  const words = [
    word('CREDIT', 50, 500, 150),
    word('1234', 220, 500, 120),
    word('BET', 50, 560, 100),
    word('5', 170, 560, 30),
    word('WIN', 700, 560, 100),
    word('40', 820, 560, 80),
  ];
  const m = readMeters(words);
  assert.equal(m.credits, 1234);
  assert.equal(m.bet, 5);
  assert.equal(m.win, 40);
  assert.deepEqual(m.found.sort(), ['bet', 'credits', 'win']);
});

test('readMeters reads a value printed underneath its label', () => {
  const words = [
    word('CREDITS', 100, 400, 160),
    word('980', 110, 450, 100),
  ];
  assert.equal(readMeters(words).credits, 980);
});

test('readMeters handles a label and value fused into one token', () => {
  assert.equal(readMeters([word('CREDIT:750', 50, 500, 220)]).credits, 750);
});

test('readMeters detects cash machines and reports missing meters as null', () => {
  const words = [word('CASH', 50, 500, 120), word('$40.25', 190, 500, 140)];
  const m = readMeters(words);
  assert.equal(m.credits, 40.25);
  assert.equal(m.cash, true);
  assert.equal(m.bet, null);
  assert.equal(m.win, null);
});

test('readMeters does not hand the same number to two meters', () => {
  const words = [
    word('CREDIT', 50, 500, 150),
    word('BET', 50, 560, 100),
    word('200', 220, 530, 100),
  ];
  const m = readMeters(words);
  const claimed = [m.credits, m.bet].filter((v) => v === 200);
  assert.equal(claimed.length, 1, 'one meter should claim the value, not both');
});

test('pairScore prefers the value to the right on the same line', () => {
  const label = { text: 'BET', x: 100, y: 100, w: 80, h: 30 };
  const right = { text: '5', x: 200, y: 100, w: 20, h: 30 };
  const below = { text: '9', x: 100, y: 160, w: 20, h: 30 };
  assert.ok(pairScore(label, right) < pairScore(label, below));
});

test('normalizeWords accepts both bbox and pre-normalized shapes', () => {
  const out = normalizeWords([
    { text: 'A', bbox: { x0: 0, y0: 0, x1: 10, y1: 20 } },
    { text: 'B', x: 5, y: 5, w: 4, h: 4, conf: 50 },
    { text: '  ', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual({ x: out[0].x, y: out[0].y }, { x: 5, y: 10 });
});

test('Stabilizer only accepts a value once it has been seen twice', () => {
  const s = new Stabilizer({ window: 4, votes: 2 });
  assert.deepEqual(s.push({ credits: 500 }), [], 'one sighting is not enough');
  assert.equal(s.get('credits'), null);
  assert.deepEqual(s.push({ credits: 500 }), ['credits']);
  assert.equal(s.get('credits'), 500);
});

test('Stabilizer ignores a one-frame OCR misread', () => {
  const s = new Stabilizer({ window: 4, votes: 2 });
  s.push({ credits: 500 });
  s.push({ credits: 500 });
  s.push({ credits: 8500 });          // glare turns a 5 into an 85
  assert.equal(s.get('credits'), 500, 'the outlier must not become the balance');
  s.push({ credits: 8500 });
  assert.equal(s.get('credits'), 8500, 'but a repeated value is believed');
});

test('an unreadable credit value does not let CREDIT steal the BET number', () => {
  // Glare wipes out the credit value. The old greedy matcher reached down a
  // line and reported a balance of 5 on a machine holding 500.
  const words = [
    word('CREDIT', 50, 500, 150),
    word('BET', 50, 560, 100),
    word('5', 170, 560, 30),
  ];
  const m = readMeters(words);
  assert.equal(m.bet, 5);
  assert.equal(m.credits, null, 'better to report nothing than the wrong balance');
});

test('each meter still gets its own value when all three are readable', () => {
  const words = [
    word('CREDIT', 50, 500, 150), word('1234', 220, 500, 120),
    word('BET', 50, 560, 100), word('5', 170, 560, 30),
    word('WIN', 700, 560, 100), word('40', 820, 560, 80),
  ];
  const m = readMeters(words);
  assert.deepEqual([m.credits, m.bet, m.win], [1234, 5, 40]);
});

test('a fused token wins over a distant loose match', () => {
  const words = [word('CREDIT:750', 50, 500, 220), word('9', 400, 500, 30)];
  assert.equal(readMeters(words).credits, 750);
});
