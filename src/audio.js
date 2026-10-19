/**
 * audio.js — non-speech sound.
 *
 * Two jobs:
 *
 * 1. Earcons. Short sounds that carry meaning faster than words. A win chime
 *    lands in ~200ms where "you won forty credits" takes two seconds; the
 *    speech still follows, but the player already knows the answer.
 *
 * 2. Aiming sonar. The hard problem in a camera app for a blind user is
 *    pointing the camera. Speech ("move left... move left... left") is slow
 *    and maddening. Instead we play a continuous tone that encodes the
 *    machine screen's position: it pans toward the side the screen is on,
 *    its pitch rises when the screen is above centre, and it pulses faster
 *    as you get closer to framed. You steer toward the sound, like a
 *    metal detector. When it locks, it stops and chimes once.
 */

export class AudioCues {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.7;
    this.sonar = null;
  }

  /** Must be called from a user gesture (mobile autoplay policy). */
  async resume() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx.state === 'running';
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  /** One shaped sine/triangle blip. */
  tone(freq, startAt, durationSec, { type = 'sine', gain = 0.25, pan = 0, slideTo = null } = {}) {
    if (!this.ctx || !this.enabled) return;
    const t0 = this.ctx.currentTime + startAt;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + durationSec);

    // Short attack/decay so it never clicks.
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durationSec);

    let node = g;
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      node = p;
    }
    osc.connect(g);
    node.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + durationSec + 0.05);
  }

  /**
   * Play a named cue.
   * @param {string} name
   * @param {object} opts  e.g. { multiplier } to scale the win fanfare
   */
  play(name, opts = {}) {
    if (!this.ctx || !this.enabled) return;
    switch (name) {
      case 'spin':
        this.tone(320, 0, 0.07, { type: 'triangle', gain: 0.12 });
        break;

      case 'win': {
        // Rising major arpeggio; more notes the bigger the win.
        const mult = Math.max(1, opts.multiplier || 1);
        const notes = [523, 659, 784, 1047, 1319, 1568];
        const count = Math.min(notes.length, 2 + Math.floor(Math.log2(mult + 1)));
        for (let i = 0; i < count; i++) this.tone(notes[i], i * 0.085, 0.22, { gain: 0.3 });
        break;
      }

      case 'bigwin': {
        const seq = [523, 659, 784, 1047, 784, 1047, 1319, 1568];
        seq.forEach((f, i) => this.tone(f, i * 0.1, 0.3, { type: 'triangle', gain: 0.33 }));
        this.tone(262, 0, 1.2, { type: 'sine', gain: 0.12 });
        break;
      }

      case 'loss':
        this.tone(196, 0, 0.16, { type: 'sine', gain: 0.11, slideTo: 150 });
        break;

      case 'lock':
        this.tone(784, 0, 0.1, { gain: 0.28 });
        this.tone(1175, 0.09, 0.16, { gain: 0.28 });
        break;

      case 'lost':
        this.tone(440, 0, 0.14, { type: 'sawtooth', gain: 0.12, slideTo: 300 });
        this.tone(300, 0.15, 0.2, { type: 'sawtooth', gain: 0.12, slideTo: 220 });
        break;

      case 'error':
        this.tone(300, 0, 0.12, { type: 'square', gain: 0.1 });
        this.tone(220, 0.13, 0.18, { type: 'square', gain: 0.1 });
        break;

      case 'start':
        this.tone(440, 0, 0.12, { gain: 0.25 });
        this.tone(659, 0.11, 0.18, { gain: 0.25 });
        break;

      case 'stop':
        this.tone(659, 0, 0.12, { gain: 0.22 });
        this.tone(440, 0.11, 0.18, { gain: 0.22 });
        break;
    }
  }

  // --- aiming sonar -------------------------------------------------------

  /** Start the continuous aiming tone. Safe to call repeatedly. */
  startSonar() {
    if (!this.ctx || this.sonar) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const lfo = this.ctx.createOscillator();     // pulse rate = "how close am I"
    const lfoGain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.value = 440;
    gain.gain.value = 0.0;
    lfo.type = 'sine';
    lfo.frequency.value = 2;
    lfoGain.gain.value = 0.12;

    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);

    let out = gain;
    let panner = null;
    if (this.ctx.createStereoPanner) {
      panner = this.ctx.createStereoPanner();
      gain.connect(panner);
      out = panner;
    }
    osc.connect(gain);
    out.connect(this.master);
    osc.start();
    lfo.start();
    this.sonar = { osc, gain, lfo, lfoGain, panner, base: 0.12 };
  }

  /**
   * Update the aiming tone from the current framing estimate.
   * @param {{dx:number, dy:number, quality:number}} aim
   *   dx: screen centre offset, -1 (far left) .. 1 (far right)
   *   dy: -1 (above centre) .. 1 (below centre)
   *   quality: 0 (nothing found) .. 1 (perfectly framed)
   */
  updateSonar({ dx = 0, dy = 0, quality = 0 }) {
    const s = this.sonar;
    if (!s || !this.ctx) return;
    const now = this.ctx.currentTime;
    // Pan toward the screen so the player turns toward the sound.
    if (s.panner) s.panner.pan.setTargetAtTime(clamp(dx, -1, 1), now, 0.08);
    // Higher pitch = tilt up, lower = tilt down.
    const freq = 440 * Math.pow(2, -clamp(dy, -1, 1) * 0.7);
    s.osc.frequency.setTargetAtTime(freq, now, 0.08);
    // Faster pulse as framing improves — the "getting warmer" signal.
    s.lfo.frequency.setTargetAtTime(1.5 + quality * 10, now, 0.1);
    s.gain.gain.setTargetAtTime(0.05 + quality * 0.14, now, 0.1);
  }

  stopSonar() {
    const s = this.sonar;
    if (!s) return;
    this.sonar = null;
    try {
      const now = this.ctx.currentTime;
      s.gain.gain.setTargetAtTime(0.0001, now, 0.05);
      s.osc.stop(now + 0.3);
      s.lfo.stop(now + 0.3);
    } catch { /* already stopped */ }
  }
}

/** Haptics. Distinct patterns so the phone alone tells you what happened. */
export const HAPTICS = {
  spin: [12],
  win: [40, 40, 90],
  bigwin: [60, 40, 60, 40, 200],
  loss: [18],
  lock: [30, 30, 30],
  lost: [200, 80, 200],
  alert: [120, 60, 120, 60, 120],
};

export function vibrate(name) {
  const pattern = HAPTICS[name];
  if (pattern && typeof navigator !== 'undefined' && navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch { /* unsupported */ }
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
