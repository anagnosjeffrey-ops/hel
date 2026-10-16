/**
 * smoke.mjs — end-to-end check in a real browser.
 *
 * Runs practice mode in headless Chromium and asserts that a spin actually
 * produces a spoken announcement. This is the test that proves the whole
 * chain works together: canvas frame -> motion detection -> OCR -> meter
 * parsing -> spin engine -> narration. The unit tests cover the pieces; this
 * covers the wiring.
 *
 * Hermetic when the OCR assets are vendored locally:
 *   node scripts/fetch-vendor.mjs   # once
 *   node scripts/smoke.mjs
 * Without them it falls back to the CDN, which needs a network connection.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8123;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const server = spawn(process.execPath, [path.join(root, 'scripts/serve.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 600));

const vendored = fs.existsSync(path.join(root, 'vendor/tesseract/tesseract.min.js'));
if (vendored) console.log('  ..   using locally vendored OCR assets (offline run)');

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();

if (vendored) {
  const base = `http://localhost:${PORT}/vendor/tesseract`;
  await page.addInitScript(([b]) => {
    window.TESSERACT_URL_OVERRIDE = `${b}/tesseract.min.js`;
    window.TESSERACT_PATHS = {
      workerPath: `${b}/worker.min.js`,
      corePath: `${b}/`,
      langPath: `${b}/`,
    };
  }, [base]);
}
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });

  check('page loads with its main heading', await page.locator('h1').innerText() === 'Slot Caller');

  // Every control must be reachable and named for a screen reader.
  // textContent, not innerText: buttons inside the collapsed Settings panel
  // are not rendered, but they still need accessible names.
  const unnamed = await page.$$eval('button', (els) =>
    els.filter((el) => !el.textContent.trim() && !el.getAttribute('aria-label'))
       .map((el) => el.id || el.outerHTML.slice(0, 40)));
  check('every button has an accessible name', unnamed.length === 0, unnamed.join(', '));

  const unlabelled = await page.$$eval('input, select', (els) =>
    els.filter((el) => {
      if (el.closest('label')) return false;
      const id = el.getAttribute('id');
      return !(id && document.querySelector(`label[for="${CSS.escape(id)}"]`));
    }).map((el) => el.id || el.type));
  check('every form control has a label', unlabelled.length === 0, unlabelled.join(', '));

  check('there is a live region for announcements',
    await page.locator('[aria-live="polite"]').count() > 0);

  check('the page declares its language', await page.getAttribute('html', 'lang') === 'en');

  // Headings must not skip levels, or screen reader navigation by heading
  // gets confusing.
  const headingJumps = await page.$$eval('h1,h2,h3,h4,h5,h6', (els) => {
    let prev = 0;
    const bad = [];
    for (const el of els) {
      const level = Number(el.tagName[1]);
      if (prev && level > prev + 1) bad.push(`${el.tagName} after H${prev}`);
      prev = level;
    }
    return bad;
  });
  check('heading levels do not skip', headingJumps.length === 0, headingJumps.join(', '));

  // Touch targets must be big enough to hit without looking.
  const small = await page.$$eval('.big, .secondary', (els) =>
    els.filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height < 44)
       .map((el) => el.id || el.className));
  check('control buttons are at least 44px tall', small.length === 0, small.join(', '));

  // At phone width the page must not scroll sideways.
  await page.setViewportSize({ width: 400, height: 800 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal scrolling at 400px wide', overflow <= 1, `${overflow}px overflow`);

  await page.click('#btn-practice');
  check('practice mode enables the spin button',
    await page.locator('#btn-spin').isEnabled());

  // Wait for the OCR engine to finish downloading and initialising.
  await page.waitForFunction(
    () => /Ready|Play as you normally/.test(document.getElementById('status').textContent),
    null, { timeout: 120000 }
  );
  check('the text recognition engine reports ready', true);

  await page.click('#btn-spin');

  // The whole point: a spin must produce a spoken result.
  await page.waitForFunction(
    () => /win|balance|credit/i.test(document.getElementById('last-said').textContent),
    null, { timeout: 30000 }
  );
  const said = await page.locator('#last-said').innerText();
  check('a spin is narrated', /win/i.test(said) || /balance/i.test(said), said);
  console.log(`       narrated: "${said}"`);

  await page.click('#btn-board');
  await page.waitForTimeout(400);
  const board = await page.locator('#last-said').innerText();
  check('the board can be read aloud', /row/i.test(board), board);
  console.log(`       board: "${board}"`);

  await page.click('#btn-status');
  await page.waitForTimeout(300);
  const status = await page.locator('#last-said').innerText();
  check('a session summary is available', /spin/i.test(status), status);
  check('the summary accounts for the money wagered', /wagered/i.test(status), status);
  console.log(`       summary: "${status}"`);

  await page.click('#btn-repeat');
  await page.waitForTimeout(200);
  check('repeat says something', (await page.locator('#last-said').innerText()).length > 0);

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('smoke run completed', false, String(err).split('\n')[0]);
} finally {
  await browser.close();
  server.kill();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll smoke checks passed');
process.exit(failures.length ? 1 : 0);
