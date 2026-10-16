/**
 * speech.js — the narrator.
 *
 * Priority queue so the app never talks over itself at the wrong moment: a
 * spin result barges in over a session summary, but idle chatter is dropped
 * entirely while something important is being said. Losing a sentence is
 * better than stacking up three seconds of stale narration behind it.
 *
 * Two output routes, chosen by the player:
 *   - 'tts'    : the app speaks with its own voice (default; works while
 *                TalkBack is on, and can be made much faster than prose)
 *   - 'reader' : the app writes to an aria-live region and lets TalkBack say
 *                it, for players who want one consistent voice everywhere
 */

export const PRIORITY = { critical: 3, result: 2, info: 1, chatter: 0 };

export class Narrator {
  constructor({ liveRegion = null } = {}) {
    this.route = 'tts';
    this.rate = 1.25;
    this.pitch = 1.0;
    this.volume = 1.0;
    this.voice = null;
    this.enabled = true;
    this.liveRegion = liveRegion;
    this.queue = [];
    this.current = null;
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this._keepAlive = null;
    this.history = [];
    if (this.supported) this._loadVoices();
  }

  _loadVoices() {
    const load = () => {
      this.voices = window.speechSynthesis.getVoices() || [];
      if (!this.voice && this.voices.length) {
        // Prefer a local (offline) English voice: no network lag on a casino
        // floor with bad wifi, and it keeps working in airplane mode.
        const local = this.voices.filter((v) => v.localService && /^en/i.test(v.lang));
        this.voice = local[0] || this.voices.find((v) => /^en/i.test(v.lang)) || this.voices[0];
      }
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
  }

  listVoices() {
    return (this.voices || []).map((v, i) => ({ index: i, name: v.name, lang: v.lang, local: v.localService }));
  }

  setVoiceByIndex(i) {
    if (this.voices && this.voices[i]) this.voice = this.voices[i];
  }

  /**
   * Say something.
   * @param {string} text
   * @param {object} opts
   * @param {'critical'|'result'|'info'|'chatter'} opts.priority
   * @param {boolean} opts.interrupt  cut off whatever is speaking now
   * @param {string}  opts.dedupeKey  skip if the same key was just spoken
   */
  say(text, opts = {}) {
    if (!text || !this.enabled) return;
    const priority = PRIORITY[opts.priority ?? 'info'] ?? PRIORITY.info;

    if (opts.dedupeKey && this._lastKey === opts.dedupeKey && Date.now() - this._lastKeyAt < 4000) return;
    if (opts.dedupeKey) { this._lastKey = opts.dedupeKey; this._lastKeyAt = Date.now(); }

    this.history.unshift({ text, at: Date.now() });
    this.history.length = Math.min(this.history.length, 50);

    if (this.route === 'reader') {
      this._toLiveRegion(text, priority >= PRIORITY.result);
      return;
    }
    if (!this.supported) {
      this._toLiveRegion(text, priority >= PRIORITY.result);
      return;
    }

    // Drop chatter when anything more important is in flight.
    if (priority === PRIORITY.chatter && (this.current || this.queue.length)) return;

    const item = { text, priority };
    if (opts.interrupt || priority === PRIORITY.critical) {
      this.queue = this.queue.filter((q) => q.priority >= priority);
      window.speechSynthesis.cancel();
      this.current = null;
    }
    // Insert by priority, preserving order within a priority band.
    const at = this.queue.findIndex((q) => q.priority < priority);
    if (at === -1) this.queue.push(item); else this.queue.splice(at, 0, item);
    this._pump();
  }

  _toLiveRegion(text, assertive) {
    if (!this.liveRegion) return;
    this.liveRegion.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
    // Toggle the content so repeated identical strings still get announced.
    this.liveRegion.textContent = '';
    window.setTimeout(() => { this.liveRegion.textContent = text; }, 30);
  }

  _pump() {
    if (this.current || !this.queue.length) return;
    const item = this.queue.shift();
    this.current = item;

    const u = new SpeechSynthesisUtterance(item.text);
    u.rate = this.rate;
    u.pitch = this.pitch;
    u.volume = this.volume;
    if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; }

    const done = () => {
      if (this.current === item) this.current = null;
      this._stopKeepAlive();
      this._pump();
    };
    u.onend = done;
    u.onerror = done;

    window.speechSynthesis.speak(u);
    this._startKeepAlive();
  }

  /**
   * Chromium pauses long utterances after ~15s of synthesis. Nudging resume()
   * on a timer is the standard workaround and is harmless when idle.
   */
  _startKeepAlive() {
    if (this._keepAlive) return;
    this._keepAlive = window.setInterval(() => {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }
    }, 9000);
  }

  _stopKeepAlive() {
    if (this._keepAlive && !this.queue.length && !this.current) {
      window.clearInterval(this._keepAlive);
      this._keepAlive = null;
    }
  }

  /** Stop immediately and drop everything queued. */
  shutUp() {
    this.queue = [];
    this.current = null;
    if (this.supported) window.speechSynthesis.cancel();
    this._stopKeepAlive();
  }

  get speaking() {
    return !!this.current || this.queue.length > 0;
  }
}
