/**
 * ocr.js — Tesseract.js wrapper.
 *
 * One worker, loaded lazily, never queued more than one job deep: on a phone
 * a backlog of OCR jobs turns into narration that is ten seconds behind the
 * machine, which is worse than no narration at all. If a frame arrives while
 * we are busy, we drop it — the next one is 100ms away.
 *
 * Language data is fetched once from the CDN and then served from the service
 * worker cache, so after the first run the app reads meters with no network.
 */

const TESSERACT_VERSION = '5.1.1';

// Two independent CDNs. Guest wifi and corporate networks do sometimes block
// one of them outright, and a player stuck at a machine cannot troubleshoot a
// blocked domain, so we just try the next one.
export const TESSERACT_URLS = [
  `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`,
  `https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/${TESSERACT_VERSION}/tesseract.min.js`,
];

let scriptPromise = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error(`No Tesseract global from ${url}`)));
    s.onerror = () => reject(new Error(`Could not load ${url}`));
    document.head.appendChild(s);
  });
}

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (scriptPromise) return scriptPromise;
  scriptPromise = (async () => {
    const urls = window.TESSERACT_URL_OVERRIDE
      ? [window.TESSERACT_URL_OVERRIDE, ...TESSERACT_URLS]
      : TESSERACT_URLS;
    let lastErr = null;
    for (const url of urls) {
      try {
        return await loadScript(url);
      } catch (err) {
        lastErr = err;
      }
    }
    console.warn('Tesseract load failed:', lastErr);
    throw new Error(
      'Could not download the text recognition engine. Connect to the internet once and reopen the app; after that it works offline.'
    );
  })();
  return scriptPromise;
}

/** Tesseract v5 nests words inside blocks/paragraphs/lines; v4 exposed them flat. */
export function flattenWords(data) {
  if (!data) return [];
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) out.push(w);
      }
    }
  }
  return out;
}

export class OcrEngine {
  constructor({ onProgress = () => {} } = {}) {
    this.worker = null;
    this.ready = false;
    this.busy = false;
    this.onProgress = onProgress;
    this.lastError = null;
    this.jobs = 0;
    this.totalMs = 0;
  }

  /**
   * @param {object} opts
   * @param {number} opts.timeoutMs  give up and report aloud rather than
   *   leaving the player in silence wondering whether the app is working
   */
  async init({ timeoutMs = 90000 } = {}) {
    if (this.ready) return true;
    if (this._initPromise) return this._initPromise;
    const work = (async () => {
      const Tesseract = await loadTesseract();
      this.onProgress({ stage: 'loading-language', progress: 0 });
      // Optional self-hosting: set window.TESSERACT_PATHS to serve the worker,
      // wasm core and language data from your own origin instead of a CDN.
      // Useful for a fully air-gapped install, and it is what the end-to-end
      // test uses so it never depends on the network.
      const paths = window.TESSERACT_PATHS || {};
      this.worker = await Tesseract.createWorker('eng', 1, {
        ...paths,
        logger: (m) => {
          if (m && typeof m.progress === 'number') {
            this.onProgress({ stage: m.status, progress: m.progress });
          }
        },
      });
      // Sparse text: slot screens are scattered labels, not paragraphs.
      await this.worker.setParameters({ tessedit_pageseg_mode: '11' });
      this.ready = true;
      this.onProgress({ stage: 'ready', progress: 1 });
      return true;
    })();

    // Silence is the worst possible failure for this app, so a stalled load
    // must surface as a spoken error rather than an indefinite wait.
    const timeout = new Promise((_, reject) => {
      this._timeoutId = setTimeout(
        () => reject(new Error('The text reader is taking too long to start. Check your connection and press Start again.')),
        timeoutMs
      );
    });
    this._initPromise = Promise.race([work, timeout]).finally(() => clearTimeout(this._timeoutId));

    try {
      return await this._initPromise;
    } catch (err) {
      this._initPromise = null;
      this.lastError = err;
      throw err;
    }
  }

  /**
   * Recognize a canvas. Returns { words, text, ms } or null if we were busy.
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   * @param {boolean} opts.digitsOnly  restrict the charset (used for re-reads)
   */
  async recognize(canvas, { digitsOnly = false } = {}) {
    if (!this.ready || this.busy || !canvas) return null;
    this.busy = true;
    const t0 = performance.now();
    try {
      if (digitsOnly !== this._digitsOnly) {
        await this.worker.setParameters({
          tessedit_char_whitelist: digitsOnly ? '0123456789.,$' : '',
        });
        this._digitsOnly = digitsOnly;
      }
      const { data } = await this.worker.recognize(canvas, {}, { blocks: true, text: true });
      const ms = performance.now() - t0;
      this.jobs += 1;
      this.totalMs += ms;
      return { words: flattenWords(data), text: data.text || '', ms };
    } catch (err) {
      this.lastError = err;
      return null;
    } finally {
      this.busy = false;
    }
  }

  get averageMs() {
    return this.jobs ? this.totalMs / this.jobs : 0;
  }

  async terminate() {
    if (this.worker) await this.worker.terminate();
    this.worker = null;
    this.ready = false;
    this._initPromise = null;
  }
}
