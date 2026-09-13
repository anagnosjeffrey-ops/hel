/**
 * frame.js — cheap, pure image analysis.
 *
 * Runs on every camera frame (target ~10fps on a mid-range Android), so
 * everything here works on a heavily downsampled grayscale grid — typically
 * 64x48. That is enough to answer the three questions we care about:
 *
 *   "are the reels moving?"   -> motionScore
 *   "where is the machine?"   -> findScreen  (drives the aiming sonar)
 *   "is the shot usable?"     -> sharpness / exposure
 *
 * No DOM access, typed arrays in and plain objects out, so it is unit
 * testable and could be moved into a worker unchanged.
 */

/** Downsample RGBA pixel data to a small grayscale grid (box filter). */
export function toGray(rgba, srcW, srcH, dstW = 64, dstH = 48) {
  const out = new Uint8ClampedArray(dstW * dstH);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < dstW; x++) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * xRatio));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let row = sy * srcW;
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (row + sx) * 4;
          // Rec. 601 luma, integer-ish for speed.
          sum += (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
          n++;
        }
      }
      out[y * dstW + x] = n ? sum / n : 0;
    }
  }
  return out;
}

/**
 * Fraction of cells that changed meaningfully between two frames.
 * This is the "are the reels spinning" signal. Spinning reels light up a
 * large contiguous fraction of the frame; a hand tremor moves everything a
 * little, which is why we count cells over a threshold rather than summing
 * absolute difference.
 */
export function motionScore(prev, cur, pixelThreshold = 18) {
  if (!prev || !cur || prev.length !== cur.length) return 0;
  let changed = 0;
  for (let i = 0; i < cur.length; i++) {
    if (Math.abs(cur[i] - prev[i]) > pixelThreshold) changed++;
  }
  return changed / cur.length;
}

/**
 * Motion restricted to a region of interest, expressed in normalized
 * coordinates. Once we know where the reels are, watching only them rejects
 * the player's own hand moving through the edge of frame.
 */
export function motionInRegion(prev, cur, w, h, region, pixelThreshold = 18) {
  if (!region) return motionScore(prev, cur, pixelThreshold);
  const x0 = Math.max(0, Math.floor(region.x * w));
  const x1 = Math.min(w, Math.ceil((region.x + region.w) * w));
  const y0 = Math.max(0, Math.floor(region.y * h));
  const y1 = Math.min(h, Math.ceil((region.y + region.h) * h));
  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (Math.abs(cur[i] - prev[i]) > pixelThreshold) changed++;
      total++;
    }
  }
  return total ? changed / total : 0;
}

/** Otsu's method: pick the threshold that best splits bright from dark. */
export function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let bestLow = 0;
  let bestHigh = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; bestLow = t; bestHigh = t; }
    else if (between === bestVar) { bestHigh = t; }
  }
  // A clean two-tone image ties across the whole empty gap between its two
  // peaks. Taking the middle of that plateau instead of its lower edge puts
  // the threshold where noise is least likely to push a pixel across it.
  return Math.round((bestLow + bestHigh) / 2);
}

/**
 * Locate the machine screen: the big bright rectangle in a dim room.
 * Returns normalized { x, y, w, h, coverage, found }. Uses percentile bounds
 * rather than the absolute min/max of bright pixels so one stray reflection
 * or a lit button panel doesn't blow the box up to the whole frame.
 */
export function findScreen(gray, w, h, { minCoverage = 0.04 } = {}) {
  const t = Math.max(60, otsuThreshold(gray));
  const xs = [];
  const ys = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] > t) { xs.push(x); ys.push(y); }
    }
  }
  const coverage = xs.length / (w * h);
  if (coverage < minCoverage) {
    return { found: false, x: 0, y: 0, w: 0, h: 0, coverage, threshold: t };
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
  const x0 = pct(xs, 0.04);
  const x1 = pct(xs, 0.96);
  const y0 = pct(ys, 0.04);
  const y1 = pct(ys, 0.96);
  return {
    found: true,
    x: x0 / w,
    y: y0 / h,
    w: Math.max(0, (x1 - x0)) / w,
    h: Math.max(0, (y1 - y0)) / h,
    coverage,
    threshold: t,
  };
}

/**
 * Turn a screen box into aiming feedback for the sonar and for speech.
 * dx/dy are -1..1 offsets of the screen centre from the frame centre;
 * quality is 0..1 where 1 means "well framed, start reading".
 */
export function aimFromScreen(box, { targetFill = 0.40 } = {}) {
  if (!box || !box.found) {
    return { dx: 0, dy: 0, quality: 0, fill: 0, advice: 'searching', found: false };
  }
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = (cx - 0.5) * 2;
  const dy = (cy - 0.5) * 2;
  const fill = box.w * box.h;

  const centreErr = Math.min(1, Math.hypot(dx, dy) / 0.9);
  const fillErr = Math.min(1, Math.abs(fill - targetFill) / targetFill);
  const quality = Math.max(0, 1 - (centreErr * 0.65 + fillErr * 0.35));

  // Order matters: a player pointed at the wrong wall needs to turn before
  // they need to step forward, so gross aiming errors are called out first.
  const turn = () => (Math.abs(dx) >= Math.abs(dy)
    ? (dx > 0 ? 'right' : 'left')
    : (dy > 0 ? 'down' : 'up'));

  let advice = 'good';
  if (quality > 0.78) advice = 'good';
  else if (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3) advice = turn();
  else if (fill < targetFill * 0.45) advice = 'closer';
  else if (fill > targetFill * 1.8) advice = 'back';
  else if (Math.abs(dx) > 0.18 || Math.abs(dy) > 0.18) advice = turn();

  return { dx, dy, quality, fill, advice, found: true };
}

/** Plain-English version of the aiming advice, for the speech channel. */
export const AIM_SPEECH = {
  searching: "I can't see the machine screen. Hold the phone up facing it.",
  closer: 'Move a little closer.',
  back: 'Move back a little.',
  left: 'Turn the phone left.',
  right: 'Turn the phone right.',
  up: 'Tilt the phone up.',
  down: 'Tilt the phone down.',
  good: 'Got it. Hold there.',
};

/**
 * Variance of the Laplacian — the standard cheap focus measure. A low value
 * means a blurry frame, which we skip rather than feed to OCR and misread.
 */
export function sharpness(gray, w, h) {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Mean brightness, for "too dark" / "too much glare" warnings. */
export function exposure(gray) {
  let sum = 0;
  let blown = 0;
  for (let i = 0; i < gray.length; i++) {
    sum += gray[i];
    if (gray[i] > 250) blown++;
  }
  return { mean: sum / gray.length, blownFraction: blown / gray.length };
}
