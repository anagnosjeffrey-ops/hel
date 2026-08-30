/* The behaviour that actually matters: one bill in, one bill counted; and no
 * combination of lingering, sweeping or standing still ever counts a bill
 * twice or invents one. */
import assert from 'node:assert/strict';
import { serve, launch, INSTRUMENT } from './helpers.mjs';

const PORT = 8231;
const server = await serve(PORT);
const browser = await launch();
const ctx = await browser.newContext({ permissions: ['camera'], viewport: { width: 420, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForTimeout(300);
await page.evaluate(INSTRUMENT);

const tests = [];
const check = (name, fn) => tests.push({ name, fn });
const queue = (...bills) => page.evaluate((b) => { window.__queue = b; }, bills);
const state = () => page.evaluate(() => ({
  bills: window.Tally.all().map((x) => x.value),
  total: window.Tally.totalCents() / 100,
  requests: window.__requests,
  display: document.getElementById('total').textContent
}));

async function pass(holdMs, gapMs) {
  await page.evaluate(() => { window.__scene = 'bill'; });
  await page.waitForTimeout(holdMs);
  await page.evaluate(() => { window.__scene = 'empty'; });
  await page.waitForTimeout(gapMs);
}

/* ------------------------------------------------------------------ verdicts */

check('a confident reading is counted and spoken', async () => {
  const r = await page.evaluate(() => {
    window.Tally.reset(); window.__log = [];
    window.BillReader.simulate({ bill_present: true, bills_in_frame: 1, denomination: '20',
      confidence: 0.96, side: 'front', serial: 'MB12345678A', issue: 'none' });
    return { said: window.__log.join('|'), total: window.Tally.totalCents() };
  });
  assert.equal(r.total, 2000);
  assert.match(r.said, /cue:ok/);
  assert.match(r.said, /say:twenty/);
});

check('the same serial twice in a row is not counted twice', async () => {
  const r = await page.evaluate(() => {
    const v = { bill_present: true, bills_in_frame: 1, denomination: '20',
                confidence: 0.96, side: 'front', serial: 'MB12345678A', issue: 'none' };
    window.Tally.reset();
    window.BillReader.simulate(v);
    window.BillReader.simulate(v);
    return window.Tally.totalCents();
  });
  assert.equal(r, 2000);
});

check('a different serial of the same value is counted', async () => {
  const r = await page.evaluate(() => {
    window.Tally.reset();
    window.BillReader.simulate({ bill_present: true, bills_in_frame: 1, denomination: '20',
      confidence: 0.96, side: 'front', serial: 'MB11111111A', issue: 'none' });
    window.BillReader.simulate({ bill_present: true, bills_in_frame: 1, denomination: '20',
      confidence: 0.96, side: 'front', serial: 'MB22222222B', issue: 'none' });
    return window.Tally.totalCents();
  });
  assert.equal(r, 4000);
});

check('nothing uncertain is ever counted', async () => {
  const cases = [
    ['below the confidence floor', { bill_present: true, bills_in_frame: 1, denomination: '50', confidence: 0.6, side: 'front', serial: '', issue: 'none' }],
    ['more than one bill',         { bill_present: true, bills_in_frame: 2, denomination: '10', confidence: 0.99, side: 'front', serial: '', issue: 'multiple_bills' }],
    ['too blurry to read',         { bill_present: false, bills_in_frame: 0, denomination: 'unknown', confidence: 0.2, side: 'unknown', serial: '', issue: 'blurry' }],
    ['not US currency',            { bill_present: false, bills_in_frame: 1, denomination: 'unknown', confidence: 0.9, side: 'unknown', serial: '', issue: 'not_us_currency' }],
    ['a denomination that does not exist', { bill_present: true, bills_in_frame: 1, denomination: '3', confidence: 0.99, side: 'front', serial: '', issue: 'none' }],
    ['a malformed response',       { nonsense: true }]
  ];
  for (const [label, verdict] of cases) {
    const r = await page.evaluate((v) => {
      window.Tally.reset(); window.__log = [];
      window.BillReader.simulate(v);
      return { total: window.Tally.totalCents(), said: window.__log.join('|') };
    }, verdict);
    assert.equal(r.total, 0, `counted something for: ${label}`);
    assert.match(r.said, /cue:unsure/, `no warning sound for: ${label}`);
  }
});

/* ---------------------------------------------------------------- the loop */

check('three passes count three bills and make three requests', async () => {
  await page.evaluate(() => { window.Tally.reset(); window.__requests = 0; });
  await page.click('#scan-btn');
  await page.waitForTimeout(1400);                       // background warmup
  await queue({ denomination: '20', serial: 'AA00000001A' },
              { denomination: '5',  serial: 'AA00000002B' },
              { denomination: '100', serial: 'AA00000003C' });
  await pass(700, 900);
  await pass(700, 900);
  await pass(700, 900);
  const r = await state();
  assert.deepEqual(r.bills, [20, 5, 100]);
  assert.equal(r.requests, 3, 'one request per bill');
  assert.equal(r.display, '$125');
});

check('a bill left in frame for three seconds counts once', async () => {
  const before = await state();
  await queue({ denomination: '10', serial: 'BB00000001A' });
  await pass(3000, 900);
  const after = await state();
  assert.equal(after.bills.length, before.bills.length + 1);
  assert.equal(after.requests, before.requests + 1);
});

check('an unbroken sweep never double-counts the first bill', async () => {
  const before = await state();
  await queue({ denomination: '50', serial: 'CC00000001A' },
              { denomination: '50', serial: 'CC00000002B' });
  await page.evaluate(() => { window.__scene = 'bill'; });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__scene = 'empty'; });
  await page.waitForTimeout(900);
  const after = await state();
  // Without a gap the second bill is missed rather than the first counted
  // twice. A miss is recoverable; a double-count is not.
  assert.equal(after.bills.length, before.bills.length + 1);
});

check('an empty frame costs nothing', async () => {
  const before = await state();
  await page.waitForTimeout(2000);
  const after = await state();
  assert.equal(after.requests, before.requests, 'made a request with nothing in frame');
});

check('stopping announces the total', async () => {
  await page.evaluate(() => { window.__log = []; });
  await page.click('#scan-btn');
  await page.waitForTimeout(250);
  const log = await page.evaluate(() => window.__log.join('|'));
  assert.match(log, /say:Total .* dollars/);
  assert.equal(await page.locator('#scan-btn').textContent(), 'Start scanning');
});

/* ------------------------------------------------------------------- tally */

check('totals and breakdowns read naturally', async () => {
  const r = await page.evaluate(() => {
    window.Tally.reset();
    [20, 20, 5, 1, 1, 1, 100].forEach((v) => window.Tally.add(v, {}));
    const before = window.Tally.totalCents();
    const breakdown = window.Tally.spokenBreakdown();
    window.Tally.undo();
    return {
      before,
      breakdown,
      money: window.Voice.money(before),
      afterUndo: window.Tally.totalCents()
    };
  });
  assert.equal(r.before, 14800);
  assert.equal(r.money, '148 dollars');
  assert.equal(r.breakdown, '1 hundred, 2 twenties, 1 five and 3 ones.');
  assert.equal(r.afterUndo, 4800);
});

/* ------------------------------------------------------------------ report */

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log('  ok   ' + t.name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + t.name + '\n       ' + e.message);
  }
}
if (errors.length) {
  failed++;
  console.log('  FAIL no uncaught page errors\n       ' + errors.join('\n       '));
} else {
  console.log('  ok   no uncaught page errors');
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} failing` : `\n${tests.length + 1} passing`);
process.exit(failed ? 1 : 0);
