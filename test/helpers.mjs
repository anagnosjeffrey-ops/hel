/* Shared plumbing for the tests: a static server for the app, and a Chromium
 * launch that works both locally and in a container with a preinstalled
 * browser. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.mjs': 'text/javascript', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png'
};

export function serve(port) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

export async function launch() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    // Fall back to a globally installed Playwright, which is how it tends to be
    // available in containers and CI images.
    try {
      const { execSync } = await import('node:child_process');
      const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
      ({ chromium } = await import(
        pathToFileURL(path.join(globalRoot, 'playwright', 'index.mjs')).href));
    } catch {
      console.error('These tests need Playwright:  npm install  (or npm i -g playwright)');
      process.exit(1);
    }
  }
  const opts = {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
           '--autoplay-policy=no-user-gesture-required']
  };
  // Honour a preinstalled browser if one is present, otherwise let Playwright
  // find its own.
  const preinstalled = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (preinstalled && fs.existsSync(preinstalled)) {
    const dir = fs.readdirSync(preinstalled).find((d) => /^chromium-\d/.test(d));
    const exe = dir && path.join(preinstalled, dir, 'chrome-linux', 'chrome');
    if (exe && fs.existsSync(exe)) opts.executablePath = exe;
  }
  return chromium.launch(opts);
}

/* Replaces the camera with scripted frames and the model with canned verdicts,
 * so the counting loop can be driven deterministically. */
export const INSTRUMENT = () => {
  window.__log = [];
  window.__requests = 0;
  window.Voice.say = (t) => window.__log.push('say:' + t);
  window.Voice.cue = (n) => window.__log.push('cue:' + n);
  window.Voice.unlock = () => {};

  const W = 128, H = 96;
  window.__scene = 'empty';
  window.Cam.live = () => true;
  window.Cam.grayFrame = () => {
    const d = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 88 + ((x * 7 + y * 3) % 5);                        // a flat wall
      if (window.__scene === 'bill' &&
          x > W * 0.14 && x < W * 0.86 && y > H * 0.16 && y < H * 0.84) {
        v = ((x >> 1) + (y >> 1)) % 2 ? 210 : 40;                // engraved detail
      }
      d[y * W + x] = v;
    }
    return { data: d, w: W, h: H };
  };
  window.Cam.snapshot = () => ({ base64: 'FAKE', dataUrl: 'data:,' });

  window.__queue = [];
  window.Recognizer.identify = () => {
    window.__requests++;
    const next = window.__queue.shift() || { denomination: '1', serial: '' };
    return new Promise((r) => setTimeout(() => r({
      bill_present: true, bills_in_frame: 1, denomination: next.denomination,
      confidence: 0.95, side: 'front', serial: next.serial, issue: 'none'
    }), 350));
  };
  window.Tally.reset();
};
