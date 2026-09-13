import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toGray, motionScore, motionInRegion, otsuThreshold, findScreen,
  aimFromScreen, sharpness, exposure,
} from '../src/frame.js';

const W = 64;
const H = 48;

/** A dark frame with one bright rectangle in it, in grid coordinates. */
function frameWith(rect, { bg = 20, fg = 240 } = {}) {
  const g = new Uint8ClampedArray(W * H).fill(bg);
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) g[y * W + x] = fg;
    }
  }
  return g;
}

test('toGray averages colour down to a small luminance grid', () => {
  const srcW = 8;
  const srcH = 8;
  const rgba = new Uint8ClampedArray(srcW * srcH * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; rgba[i + 3] = 255;
  }
  const g = toGray(rgba, srcW, srcH, 4, 4);
  assert.equal(g.length, 16);
  assert.ok(g.every((v) => v > 250), 'white in, white out');
});

test('motionScore is near zero for a still scene and high for a moving one', () => {
  const a = frameWith({ x: 16, y: 12, w: 32, h: 24 });
  const still = motionScore(a, a);
  assert.equal(still, 0);

  const b = frameWith({ x: 20, y: 12, w: 32, h: 24 });
  assert.ok(motionScore(a, b) > 0.05, 'shifted reels should register as motion');
});

test('motionScore ignores a mismatched or missing frame instead of throwing', () => {
  assert.equal(motionScore(null, frameWith(null)), 0);
  assert.equal(motionScore(new Uint8ClampedArray(4), frameWith(null)), 0);
});

test('motionInRegion ignores movement outside the reels', () => {
  const a = frameWith({ x: 4, y: 4, w: 8, h: 8 });        // a hand at top left
  const b = frameWith({ x: 4, y: 20, w: 8, h: 8 });       // the hand moved
  const reels = { x: 0.5, y: 0.5, w: 0.4, h: 0.4 };       // reels are bottom right
  assert.equal(motionInRegion(a, b, W, H, reels), 0);
  assert.ok(motionInRegion(a, b, W, H, null) > 0, 'whole-frame motion still sees it');
});

test('otsuThreshold splits a two-tone image between its two tones', () => {
  const g = frameWith({ x: 16, y: 12, w: 32, h: 24 });
  const t = otsuThreshold(g);
  assert.ok(t > 20 && t < 240, `threshold ${t} should fall between the two levels`);
  // And it should sit near the middle of the gap, not hard against one tone.
  assert.ok(Math.abs(t - 130) < 30, `threshold ${t} should be mid-gap`);
});

test('findScreen locates a bright panel and reports it in normalized units', () => {
  const g = frameWith({ x: 16, y: 12, w: 32, h: 24 });
  const box = findScreen(g, W, H);
  assert.equal(box.found, true);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  assert.ok(Math.abs(cx - 0.5) < 0.06, `centre x ${cx} should be near the middle`);
  assert.ok(Math.abs(cy - 0.5) < 0.06, `centre y ${cy} should be near the middle`);
});

test('findScreen reports nothing rather than guessing at an empty frame', () => {
  assert.equal(findScreen(frameWith(null), W, H).found, false);
});

test('findScreen is not dragged off by a single stray highlight', () => {
  const g = frameWith({ x: 26, y: 18, w: 16, h: 12 });
  g[2 * W + 2] = 255;                                     // a lone reflection
  const box = findScreen(g, W, H);
  assert.ok(box.x > 0.2, 'the box should stay on the panel, not stretch to the corner');
});

test('aiming tells you which way to turn', () => {
  const left = aimFromScreen(findScreen(frameWith({ x: 2, y: 18, w: 20, h: 14 }), W, H));
  assert.equal(left.advice, 'left');
  assert.ok(left.dx < 0);

  const right = aimFromScreen(findScreen(frameWith({ x: 42, y: 18, w: 20, h: 14 }), W, H));
  assert.equal(right.advice, 'right');
  assert.ok(right.dx > 0);

  const up = aimFromScreen(findScreen(frameWith({ x: 22, y: 1, w: 20, h: 12 }), W, H));
  assert.equal(up.advice, 'up');

  const down = aimFromScreen(findScreen(frameWith({ x: 22, y: 34, w: 20, h: 12 }), W, H));
  assert.equal(down.advice, 'down');
});

test('aiming says "good" and scores high once the panel is centred and large', () => {
  const aim = aimFromScreen(findScreen(frameWith({ x: 14, y: 10, w: 36, h: 28 }), W, H));
  assert.equal(aim.advice, 'good');
  assert.ok(aim.quality > 0.78, `quality was ${aim.quality}`);
});

test('aiming asks you to move closer when the panel is tiny but centred', () => {
  const aim = aimFromScreen(findScreen(frameWith({ x: 25, y: 19, w: 14, h: 10 }), W, H));
  assert.equal(aim.advice, 'closer');
});

test('aiming reports zero quality when it cannot find a screen at all', () => {
  const aim = aimFromScreen(findScreen(frameWith(null), W, H));
  assert.equal(aim.found, false);
  assert.equal(aim.quality, 0);
  assert.equal(aim.advice, 'searching');
});

test('sharpness separates a crisp edge from a flat blur', () => {
  const crisp = frameWith({ x: 16, y: 12, w: 32, h: 24 });
  const flat = frameWith(null, { bg: 128 });
  assert.ok(sharpness(crisp, W, H) > sharpness(flat, W, H));
});

test('exposure reports darkness and blown-out glare', () => {
  const dark = exposure(frameWith(null, { bg: 5 }));
  assert.ok(dark.mean < 22, 'a dark frame should read as too dark to OCR');

  const glare = exposure(frameWith({ x: 0, y: 0, w: 64, h: 48 }, { fg: 255 }));
  assert.ok(glare.blownFraction > 0.9);
});
