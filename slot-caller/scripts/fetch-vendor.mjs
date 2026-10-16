/**
 * fetch-vendor.mjs — download the OCR engine for offline / self-hosted use.
 *
 * Two reasons to run this:
 *   1. The end-to-end test then runs with no network at all.
 *   2. You can serve the whole app from your own origin, with no CDN,
 *      by pointing window.TESSERACT_PATHS at vendor/tesseract (see ocr.js).
 *
 *   node scripts/fetch-vendor.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'vendor/tesseract');

const JS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist';
const CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';
const DATA = 'https://tessdata.projectnaptha.com/4.0.0';

const FILES = [
  `${JS}/tesseract.min.js`,
  `${JS}/worker.min.js`,
  // Tesseract picks one of these at runtime depending on what the device
  // supports (SIMD, and LSTM-only vs the full legacy engine), so all four
  // have to be present for a self-hosted copy to work on every phone.
  `${CORE}/tesseract-core.wasm.js`,
  `${CORE}/tesseract-core-lstm.wasm.js`,
  `${CORE}/tesseract-core-simd.wasm.js`,
  `${CORE}/tesseract-core-simd-lstm.wasm.js`,
  `${DATA}/eng.traineddata.gz`,
];

await fs.mkdir(out, { recursive: true });

let failed = 0;
for (const url of FILES) {
  const name = url.split('/').pop();
  const dest = path.join(out, name);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(dest, buf);
    console.log(`  ${name.padEnd(36)} ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  } catch (err) {
    failed++;
    console.error(`  ${name.padEnd(36)} FAILED — ${err.message}`);
  }
}

console.log(failed ? `\n${failed} file(s) failed` : `\nVendored to ${path.relative(root, out)}`);
process.exit(failed ? 1 : 0);
