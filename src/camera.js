/**
 * camera.js — rear camera capture for Android Chrome.
 *
 * Keeps one <video> element fed by getUserMedia and hands out frames in the
 * two shapes the rest of the app needs: a small RGBA buffer for per-frame
 * analysis, and a JPEG for the occasional cloud vision call.
 *
 * Torch control matters here: casino floors are dark and machine screens are
 * bright, so autoexposure often crushes the meters. The torch is exposed as a
 * toggle rather than used automatically — a light pointed at a machine is the
 * player's call, not ours.
 */

export class Camera {
  constructor() {
    this.stream = null;
    this.video = null;
    this.track = null;
    this.analysisCanvas = document.createElement('canvas');
    this.analysisCtx = this.analysisCanvas.getContext('2d', { willReadFrequently: true });
    this.captureCanvas = document.createElement('canvas');
    this.captureCtx = this.captureCanvas.getContext('2d', { willReadFrequently: true });
    this.analysisWidth = 320;
    this.torchOn = false;
  }

  get running() {
    return !!this.stream && !!this.video && this.video.readyState >= 2;
  }

  /**
   * Start the rear camera. Throws a plain-language Error on failure so the
   * caller can speak it aloud verbatim.
   */
  async start(videoEl, { deviceId = null } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot use the camera. Please use Chrome on Android.');
    }
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          },
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        throw new Error(
          'Camera permission was refused. Open your browser settings for this site and allow the camera, then press Start again.'
        );
      }
      if (err && err.name === 'NotFoundError') {
        throw new Error('No camera was found on this device.');
      }
      throw new Error(`The camera could not start. ${err?.message || 'Unknown error.'}`);
    }

    this.video = videoEl;
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    this.track = this.stream.getVideoTracks()[0];

    // Prefer continuous autofocus when the device exposes it.
    try {
      const caps = this.track.getCapabilities?.() || {};
      const advanced = [];
      if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
      if (advanced.length) await this.track.applyConstraints({ advanced });
    } catch { /* optional */ }

    await this._waitForSize();
    return {
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      torchAvailable: this.torchAvailable,
    };
  }

  _waitForSize() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.video.videoWidth > 0) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
  }

  get torchAvailable() {
    try {
      return !!this.track?.getCapabilities?.().torch;
    } catch {
      return false;
    }
  }

  async setTorch(on) {
    if (!this.torchAvailable) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      this.torchOn = !!on;
      return true;
    } catch {
      return false;
    }
  }

  async toggleTorch() {
    return this.setTorch(!this.torchOn);
  }

  /** Small RGBA frame for motion/brightness analysis. */
  grabAnalysisFrame() {
    if (!this.running) return null;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const w = this.analysisWidth;
    const h = Math.max(1, Math.round((vh / vw) * w));
    if (this.analysisCanvas.width !== w) {
      this.analysisCanvas.width = w;
      this.analysisCanvas.height = h;
    }
    this.analysisCtx.drawImage(this.video, 0, 0, w, h);
    return this.analysisCtx.getImageData(0, 0, w, h);
  }

  /**
   * Full-resolution capture for OCR, optionally cropped to a normalized
   * region and upscaled — small text OCRs far better when scaled up.
   * @returns {HTMLCanvasElement}
   */
  grabCapture({ region = null, maxWidth = 1600, scale = 1 } = {}) {
    if (!this.running) return null;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const sx = region ? Math.round(region.x * vw) : 0;
    const sy = region ? Math.round(region.y * vh) : 0;
    const sw = region ? Math.round(region.w * vw) : vw;
    const sh = region ? Math.round(region.h * vh) : vh;

    let dw = Math.round(sw * scale);
    let dh = Math.round(sh * scale);
    if (dw > maxWidth) {
      dh = Math.round(dh * (maxWidth / dw));
      dw = maxWidth;
    }
    this.captureCanvas.width = Math.max(1, dw);
    this.captureCanvas.height = Math.max(1, dh);
    this.captureCtx.drawImage(this.video, sx, sy, sw, sh, 0, 0, dw, dh);
    return this.captureCanvas;
  }

  /** Base64 JPEG (no data: prefix) for the vision API. */
  grabJpegBase64({ region = null, maxWidth = 1100, quality = 0.72 } = {}) {
    const canvas = this.grabCapture({ region, maxWidth });
    if (!canvas) return null;
    const url = canvas.toDataURL('image/jpeg', quality);
    return url.slice(url.indexOf(',') + 1);
  }

  async listCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    } catch {
      return [];
    }
  }

  stop() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    this.stream = null;
    this.track = null;
    if (this.video) this.video.srcObject = null;
  }
}

/**
 * Binarize a capture before OCR, using a local (adaptive) threshold.
 *
 * This matters more than anything else in the OCR path. Slot machine meters
 * are almost always *bright text on a dark panel*, and Tesseract expects the
 * opposite. Worse, a single global threshold is hopeless on a slot screen,
 * because one frame contains a blazing white reel window next to a near-black
 * meter strip — whatever threshold suits one destroys the other.
 *
 * So we compare each pixel against the average of its own neighbourhood using
 * an integral image (Bradley-Roth adaptive thresholding, O(n) regardless of
 * window size) and emit black-on-white, which is what Tesseract wants.
 *
 * @param {HTMLCanvasElement} canvas  modified in place
 * @param {object} opts
 * @param {boolean} opts.brightText   true when the text is lighter than its
 *   surroundings (the normal case for a slot meter); false for dark text on
 *   a light panel, e.g. a printed paytable
 * @param {number} opts.tolerance     fraction a pixel must differ from its
 *   local mean before it counts as text; higher rejects more noise
 */
export function preprocessForOcr(canvas, { brightText = true, tolerance = 0.12 } = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return canvas;

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  // Integer arrays throughout: a mid-range phone runs this a few times a
  // second on a megapixel frame, and Float64 versions of these two buffers
  // cost ~16MB per pass. A Uint32 integral tops out around 4.3 billion, well
  // clear of the largest possible sum here (255 x pixel count).
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    gray[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  }

  // Integral image, with one row/column of padding so window sums need no
  // clamping inside the inner loop.
  const iw = w + 1;
  const integral = new Uint32Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }

  // A window around one eighth of the image width comfortably contains a
  // meter's digits plus some of the panel behind them.
  const half = Math.max(4, Math.round(Math.min(w, h) / 16));

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w - 1, x + half);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * iw + (x1 + 1)] -
        integral[y0 * iw + (x1 + 1)] -
        integral[(y1 + 1) * iw + x0] +
        integral[y0 * iw + x0];
      const mean = sum / count;
      const v = gray[y * w + x];
      const isText = brightText
        ? v > mean * (1 + tolerance)
        : v < mean * (1 - tolerance);
      const out = isText ? 0 : 255;
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = out;
      d[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}
