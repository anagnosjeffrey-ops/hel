/**
 * reading.js — turn raw OCR words into slot-machine meter values.
 *
 * Design note (accessibility): a blind player cannot draw calibration boxes
 * around the credit meter. So we never ask them to. Instead we exploit the
 * fact that every slot machine labels its own meters on screen — CREDIT,
 * BET, WIN, PAID — and we anchor to those printed labels, taking the nearest
 * plausible number. Zero setup, works on a machine the app has never seen.
 *
 * Everything in this file is pure so it can be unit tested without a camera.
 */

/** Label patterns, most specific first. Order matters within a meter. */
export const METER_PATTERNS = {
  credits: [
    /^credits?$/i,
    /^cash\s*credits?$/i,
    /^credit\s*meter$/i,
    /^balance$/i,
    /^cash$/i,
    /^bank$/i,
    /^available$/i,
  ],
  bet: [
    /^total\s*bet$/i,
    /^bet$/i,
    /^bets?$/i,
    /^wager$/i,
    /^stake$/i,
    /^lines?\s*bet$/i,
    /^bet\s*per\s*line$/i,
  ],
  win: [
    /^win$/i,
    /^won$/i,
    /^paid$/i,
    /^payout$/i,
    /^winner\s*paid$/i,
    /^last\s*win$/i,
  ],
};

/** Words that, if they are the nearest neighbour, mean "no value here". */
const NON_VALUE = /^(per|line|lines|max|min|denom|of|and|to)$/i;

/**
 * Normalize a Tesseract word list into a flat, geometry-friendly shape.
 * Accepts Tesseract's `{ text, confidence, bbox:{x0,y0,x1,y1} }` and also
 * an already-normalized `{ text, conf, x, y, w, h }`.
 */
export function normalizeWords(rawWords) {
  const out = [];
  for (const w of rawWords || []) {
    if (!w) continue;
    const text = String(w.text ?? '').trim();
    if (!text) continue;
    let x, y, width, height;
    if (w.bbox) {
      const { x0, y0, x1, y1 } = w.bbox;
      x = (x0 + x1) / 2;
      y = (y0 + y1) / 2;
      width = Math.abs(x1 - x0);
      height = Math.abs(y1 - y0);
    } else {
      x = w.x; y = w.y; width = w.w ?? 0; height = w.h ?? 0;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({
      text,
      conf: w.conf ?? w.confidence ?? 0,
      x, y, w: width, h: height || 1,
    });
  }
  return out;
}

/**
 * Parse a numeric token as it appears on a slot display.
 * Handles: 1234  1,234  1 234  $12.34  12.34  0.40  "1,234.56"
 * Returns { value, cash } or null. `cash` is true when the token looked like
 * money (leading currency symbol, or exactly two decimal places).
 */
export function parseNumber(token) {
  if (token == null) return null;
  let s = String(token).trim();
  if (!s) return null;

  // OCR frequently confuses these on seven-segment / stylised slot fonts.
  s = s.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1').replace(/[Ss](?=\d)/g, '5');

  const cashSymbol = /^[$€£¥]/.test(s);
  s = s.replace(/^[$€£¥]\s*/, '').replace(/\s+/g, '');
  // Strip trailing junk OCR sometimes appends.
  s = s.replace(/[^\d.,]+$/, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;

  // Decide whether the last separator is a decimal point or a thousands mark.
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const lastSep = Math.max(lastDot, lastComma);
  let decimals = 0;
  let intPart = s;
  if (lastSep !== -1) {
    const tail = s.slice(lastSep + 1);
    // 1,234 -> thousands. 12.34 -> decimal. 1.234.567 -> thousands.
    // A 1-2 digit tail is a decimal fraction; a 3 digit tail is a thousands group.
    if (/^\d{1,2}$/.test(tail)) {
      decimals = tail.length;
      intPart = s.slice(0, lastSep);
    }
  }
  const digits = intPart.replace(/[.,]/g, '');
  if (!digits) return null;
  const whole = Number(digits);
  if (!Number.isFinite(whole)) return null;
  const value = decimals ? Number(`${digits}.${s.slice(lastSep + 1)}`) : whole;
  if (!Number.isFinite(value)) return null;
  return { value, cash: cashSymbol || decimals === 2 };
}

/** True if a word is a plain numeric value token. */
export function isValueToken(word) {
  return parseNumber(word.text) !== null && !NON_VALUE.test(word.text);
}

/**
 * Score how good a candidate value word is for a given label word.
 * Slot layouts put the value to the right of the label, or directly beneath it.
 * Lower score wins; null means "not a plausible pairing".
 */
export function pairScore(label, value) {
  const dx = value.x - label.x;
  const dy = value.y - label.y;
  const rowTol = Math.max(label.h, value.h) * 1.2;
  const near = Math.max(label.h, value.h);

  // Same line, to the right — the most common layout.
  if (Math.abs(dy) <= rowTol && dx > 0 && dx < near * 22) {
    return dx + Math.abs(dy) * 2;
  }
  // Directly below, roughly column-aligned — second most common.
  if (dy > 0 && dy < near * 3.2 && Math.abs(dx) < near * 8) {
    return dy * 1.6 + Math.abs(dx) * 2 + near * 2;
  }
  // Same line, to the left (right-aligned meters) — least preferred.
  if (Math.abs(dy) <= rowTol && dx < 0 && -dx < near * 10) {
    return -dx * 2.5 + Math.abs(dy) * 2 + near * 4;
  }
  return null;
}

/**
 * Find one meter's value by anchoring on its printed label.
 * Returns { value, cash, conf, label } or null.
 */
export function findMeter(words, patterns, { exclude = new Set() } = {}) {
  const labels = [];
  for (const w of words) {
    const clean = w.text.replace(/[:=]+$/, '');
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(clean)) {
        labels.push({ word: w, rank: i });
        break;
      }
    }
    // Label and value fused into one token, e.g. "CREDIT:1234".
    const fused = /^([A-Za-z ]{3,12})[:=]\s*([\d.,$]+)$/.exec(w.text);
    if (fused && patterns.some((p) => p.test(fused[1].trim()))) {
      const num = parseNumber(fused[2]);
      if (num) return { ...num, conf: w.conf, label: fused[1].trim(), fused: true };
    }
  }
  if (!labels.length) return null;
  labels.sort((a, b) => a.rank - b.rank);

  let best = null;
  for (const { word: label, rank } of labels) {
    for (const v of words) {
      if (v === label || exclude.has(v)) continue;
      if (!isValueToken(v)) continue;
      const s = pairScore(label, v);
      if (s == null) continue;
      const score = s + rank * 5;
      if (!best || score < best.score) best = { score, label, value: v };
    }
  }
  if (!best) return null;
  const num = parseNumber(best.value.text);
  if (!num) return null;
  return { ...num, conf: best.value.conf, label: best.label.text, word: best.value };
}

/**
 * Read every meter we understand out of one OCR pass.
 *
 * Assignment is global, not one meter at a time, and that matters. Consider a
 * frame where the credit value is smeared by glare but everything else reads
 * cleanly. Matching meters one by one, CREDIT finds no number beside it,
 * reaches down to the next line, and claims the BET value instead — so the
 * app cheerfully announces a balance of 5 when the machine says 500. Scoring
 * every label/value pairing together and handing each number to the label
 * that wants it most makes that impossible: BET is a far better match for its
 * own value, so it wins, and CREDIT correctly reports nothing at all.
 *
 * Returns { credits, bet, win, cash, conf, found, text }, each meter being a
 * number or null. Null means "not read", never "zero".
 */
export function readMeters(rawWords) {
  const words = normalizeWords(rawWords);
  const result = { credits: null, bet: null, win: null, cash: false, conf: 0, found: [] };
  result.text = words.map((w) => w.text).join(' ');

  const values = words.filter(isValueToken);
  const takenValue = new Set();

  // Fused "CREDIT:750" tokens are unambiguous, so settle them first.
  for (const w of words) {
    const fused = /^([A-Za-z ]{3,12})[:=]\s*([\d.,$]+)$/.exec(w.text);
    if (!fused) continue;
    for (const meter of ['credits', 'bet', 'win']) {
      if (result[meter] != null) continue;
      if (!METER_PATTERNS[meter].some((pat) => pat.test(fused[1].trim()))) continue;
      const num = parseNumber(fused[2]);
      if (!num) continue;
      result[meter] = num.value;
      result.cash = result.cash || num.cash;
      result.conf = Math.max(result.conf, w.conf || 0);
      result.found.push(meter);
      takenValue.add(w);
    }
  }

  // Score every plausible label/value pairing across all meters at once.
  const candidates = [];
  for (const meter of ['credits', 'bet', 'win']) {
    if (result[meter] != null) continue;
    const patterns = METER_PATTERNS[meter];
    for (const label of words) {
      const clean = label.text.replace(/[:=]+$/, '');
      const rank = patterns.findIndex((pat) => pat.test(clean));
      if (rank === -1) continue;
      for (const value of values) {
        if (value === label || takenValue.has(value)) continue;
        const base = pairScore(label, value);
        if (base == null) continue;
        // Later patterns are looser synonyms, so nudge their scores worse.
        candidates.push({ meter, label, value, score: base + rank * 5 });
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score);

  for (const c of candidates) {
    if (result[c.meter] != null || takenValue.has(c.value)) continue;
    const num = parseNumber(c.value.text);
    if (!num) continue;
    result[c.meter] = num.value;
    result.cash = result.cash || num.cash;
    result.conf = Math.max(result.conf, c.value.conf || 0);
    result.found.push(c.meter);
    takenValue.add(c.value);
  }

  return result;
}

/**
 * Stabiliser: OCR on a moving handheld camera is noisy, so we only trust a
 * value once we have seen it more than once in a short window. This is what
 * stops the app from shouting a wrong balance at the player.
 */
export class Stabilizer {
  constructor({ window = 4, votes = 2 } = {}) {
    this.window = window;
    this.votes = votes;
    this.history = new Map(); // field -> array of values
    this.stable = new Map();  // field -> last accepted value
  }

  /** Push one sample; returns the fields that changed to a new stable value. */
  push(reading) {
    const changed = [];
    for (const field of ['credits', 'bet', 'win']) {
      const v = reading[field];
      if (v == null) continue;
      const hist = this.history.get(field) || [];
      hist.push(v);
      while (hist.length > this.window) hist.shift();
      this.history.set(field, hist);

      const count = hist.filter((x) => x === v).length;
      if (count >= this.votes && this.stable.get(field) !== v) {
        this.stable.set(field, v);
        changed.push(field);
      }
    }
    return changed;
  }

  get(field) {
    return this.stable.has(field) ? this.stable.get(field) : null;
  }

  snapshot() {
    return {
      credits: this.get('credits'),
      bet: this.get('bet'),
      win: this.get('win'),
    };
  }

  reset() {
    this.history.clear();
    this.stable.clear();
  }
}
