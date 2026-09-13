/**
 * app.js — wiring.
 *
 * The loop, once started, runs at roughly 12Hz:
 *
 *   grab small frame -> motion score -> feed the spin engine
 *                    -> (when still) full-res crop -> OCR -> meter values
 *
 * OCR never blocks the loop; it is fired off and its result folded in when it
 * lands. The spin engine turns that stream into events, and every event is
 * turned into sound first and speech second, because a chime lands a second
 * and a half before a sentence does.
 */

import { Camera, preprocessForOcr } from './camera.js';
import { SlotSimulator } from './simulator.js';
import { OcrEngine } from './ocr.js';
import { readMeters, Stabilizer } from './reading.js';
import { SpinEngine, STATE } from './engine.js';
import { SessionTracker, describeResult, describeSession, money } from './session.js';
import { Narrator } from './speech.js';
import { AudioCues, vibrate } from './audio.js';
import { VisionClient, MODELS } from './cloud.js';
import {
  toGray, motionScore, findScreen, aimFromScreen, AIM_SPEECH, sharpness, exposure,
} from './frame.js';

const SETTINGS_KEY = 'slotcaller.settings.v1';
const LOOP_MS = 80;
const OCR_IDLE_MS = 380;
const GRAY_W = 64;
const GRAY_H = 48;

const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  route: 'tts',
  voiceIndex: null,
  rate: 1.25,
  volume: 0.7,
  announceLosses: true,
  earcons: true,
  haptics: true,
  announceBalance: true,
  autoBoard: 'never',
  lossLimit: null,
  winGoal: null,
  timeLimitMin: null,
  apiKey: '',
  model: MODELS[0].id,
  cameraId: '',
  torch: false,
  preview: false,
};

class App {
  constructor() {
    this.settings = loadSettings();
    this.el = {
      polite: $('live-polite'),
      assertive: $('live-assertive'),
      status: $('status'),
      lastSaid: $('last-said'),
      video: $('video'),
      previewWrap: $('preview-wrap'),
    };

    this.narrator = new Narrator({ liveRegion: this.el.polite });
    this.audio = new AudioCues();
    this.vision = new VisionClient({ apiKey: this.settings.apiKey, model: this.settings.model });
    this.camera = new Camera();
    this.sim = null;
    this.source = null;
    this.ocr = new OcrEngine({ onProgress: (p) => this.onOcrProgress(p) });
    this.stabilizer = new Stabilizer({ window: 4, votes: 2 });
    this.session = new SessionTracker(this.limitOpts());
    this.engine = new SpinEngine({}, (name, payload) => this.onEngineEvent(name, payload));

    this.running = false;
    this.aiming = false;
    this.prevGray = null;
    this.lastOcrAt = 0;
    this.lastAimSpeechAt = 0;
    this.lastAimAdvice = null;
    this.cashMode = false;
    this.ocrBrightText = true;
    this.ocrMisses = 0;
    this.lastAnnouncement = '';
    this.pendingVerify = null;
    this.timer = null;

    this.applySettings();
    this.bindUi();
    this.registerServiceWorker();
  }

  // --- settings -----------------------------------------------------------

  limitOpts() {
    return {
      lossLimit: this.settings.lossLimit,
      winGoal: this.settings.winGoal,
      timeLimitMin: this.settings.timeLimitMin,
    };
  }

  applySettings() {
    const s = this.settings;
    this.narrator.route = s.route;
    this.narrator.rate = s.rate;
    this.audio.enabled = s.earcons;
    this.audio.setVolume(s.volume);
    this.vision.apiKey = s.apiKey;
    this.vision.model = s.model;
    this.session.opts = { ...this.session.opts, ...this.limitOpts() };
    this.el.previewWrap.classList.toggle('hidden', !s.preview);
    if (s.voiceIndex != null) this.narrator.setVoiceByIndex(s.voiceIndex);
  }

  save() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch { /* private mode */ }
  }

  // --- announcements ------------------------------------------------------

  /** Everything spoken also lands on screen and in the live region. */
  announce(text, opts = {}) {
    if (!text) return;
    this.lastAnnouncement = text;
    this.el.lastSaid.textContent = text;
    this.narrator.say(text, opts);
    if (this.narrator.route === 'tts' && opts.priority === 'critical') {
      // Belt and braces: critical messages also go to the screen reader.
      this.el.assertive.textContent = '';
      setTimeout(() => { this.el.assertive.textContent = text; }, 30);
    }
  }

  setStatus(text) {
    this.el.status.textContent = text;
  }

  cue(name, opts) {
    if (this.settings.earcons) this.audio.play(name, opts);
    if (this.settings.haptics) vibrate(name);
  }

  // --- lifecycle ----------------------------------------------------------

  async start({ practice = false } = {}) {
    if (this.running) return;
    await this.audio.resume();

    if (practice) {
      this.sim = new SlotSimulator();
      this.source = this.sim;
      this.setStatus('Practice mode. Press the spin button or the space bar.');
      this.announce('Practice mode on. Press spin, or the space bar, to play a practice spin.', { priority: 'info' });
    } else {
      this.setStatus('Starting the camera…');
      this.announce('Starting the camera.', { priority: 'info' });
      try {
        await this.camera.start(this.el.video, { deviceId: this.settings.cameraId || null });
      } catch (err) {
        this.cue('error');
        this.setStatus(err.message);
        this.announce(err.message, { priority: 'critical' });
        return;
      }
      this.source = this.camera;
      if (this.settings.torch) await this.camera.setTorch(true);
      this.refreshCameraList();
    }

    this.running = true;
    this.prevGray = null;
    this.stabilizer.reset();
    this.session.start(null);
    $('btn-start').querySelector('.btn-title').textContent = 'Stop narrating';
    $('btn-board').disabled = false;
    $('btn-aim').disabled = practice;
    $('btn-spin').disabled = !practice;
    this.cue('start');

    this.loop();
    this.initOcr();

    if (!practice) {
      this.beginAiming();
    }
  }

  async initOcr() {
    try {
      this.setStatus('Getting the text reader ready…');
      await this.ocr.init();
      this.setStatus('Ready. Play as you normally would.');
      this.announce('Ready. I will call each spin.', { priority: 'info' });
    } catch (err) {
      this.cue('error');
      this.announce(err.message, { priority: 'critical' });
      this.setStatus(err.message);
    }
  }

  onOcrProgress({ stage, progress }) {
    if (stage === 'ready') return;
    if (stage && progress < 1) {
      this.setStatus(`Preparing text recognition: ${Math.round(progress * 100)} percent`);
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.stopAiming();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.camera.stop();
    if (this.sim) { this.sim.stop(); this.sim = null; }
    this.source = null;
    $('btn-start').querySelector('.btn-title').textContent = 'Start narrating';
    $('btn-board').disabled = true;
    $('btn-aim').disabled = true;
    $('btn-spin').disabled = true;
    this.cue('stop');
    const sum = this.session.summary();
    this.setStatus('Stopped.');
    this.announce(
      sum.spins ? `Stopped. ${describeSession(sum, this.cashMode)}` : 'Stopped.',
      { priority: 'info' }
    );
  }

  // --- main loop ----------------------------------------------------------

  loop() {
    if (!this.running) return;
    const t = performance.now();
    try {
      this.tick(t);
    } catch (err) {
      console.error(err);
    }
    this.timer = setTimeout(() => this.loop(), LOOP_MS);
  }

  tick(t) {
    const frame = this.source?.grabAnalysisFrame?.();
    if (!frame) return;

    const gray = toGray(frame.data, frame.width, frame.height, GRAY_W, GRAY_H);
    const motion = this.prevGray ? motionScore(this.prevGray, gray) : 0;
    this.prevGray = gray;

    if (this.aiming) this.updateAim(gray, t);

    const state = this.engine.push({ t, motion, meters: this.stabilizer.snapshot() });

    // OCR harder while the reels are settling: that is when the numbers we
    // are about to announce actually change.
    const interval = state === STATE.SETTLING ? 0 : OCR_IDLE_MS;
    const quiet = state !== STATE.SPINNING;
    if (quiet && this.ocr.ready && !this.ocr.busy && t - this.lastOcrAt >= interval) {
      this.lastOcrAt = t;
      this.runOcr(gray);
    }

    if (this.pendingVerify && t >= this.pendingVerify.at) this.runVerify();
  }

  runOcr(gray) {
    // Skip frames that are too blurry or too dark to read; a wrong number
    // spoken confidently is worse than silence.
    const sharp = sharpness(gray, GRAY_W, GRAY_H);
    const exp = exposure(gray);
    if (sharp < 12 || exp.mean < 22) return;

    const canvas = this.source.grabCapture({ maxWidth: 1100 });
    if (!canvas) return;
    preprocessForOcr(canvas, { brightText: this.ocrBrightText });

    this.ocr.recognize(canvas).then((res) => {
      if (!res) return;
      const meters = readMeters(res.words);

      // Self-tuning polarity. Nearly every slot meter is light text on a dark
      // panel, so that is the starting assumption — but rather than make the
      // player diagnose a machine that reads the other way round, flip after
      // a few fruitless passes and see if that works better.
      if (!meters.found.length) {
        this.ocrMisses += 1;
        if (this.ocrMisses >= 4) {
          this.ocrBrightText = !this.ocrBrightText;
          this.ocrMisses = 0;
        }
      } else {
        this.ocrMisses = 0;
      }

      if (meters.cash) this.cashMode = true;
      this.session.stats.cash = this.cashMode;
      this.lastText = meters.text;
      const changed = this.stabilizer.push(meters);
      if (changed.includes('credits')) {
        this.session.setCredits(this.stabilizer.get('credits'));
      }
      this.updateStatusLine();
    });
  }

  updateStatusLine() {
    const snap = this.stabilizer.snapshot();
    const bits = [];
    if (snap.credits != null) bits.push(`Balance ${money(snap.credits, this.cashMode)}`);
    if (snap.bet != null) bits.push(`Bet ${money(snap.bet, this.cashMode)}`);
    const sum = this.session.summary();
    if (sum.spins) bits.push(`${sum.spins} spins`);
    if (bits.length) this.setStatus(bits.join(' · '));
  }

  // --- engine events ------------------------------------------------------

  onEngineEvent(name, payload) {
    switch (name) {
      case 'spin-start':
        this.cue('spin');
        // After this, any balance read for the first time is already short
        // by the wager, so it must not become the session baseline.
        this.session.noteSpinStart();
        break;

      case 'result':
        this.onResult(payload);
        break;

      case 'lost-track':
        this.cue('lost');
        this.announce(
          "I've lost sight of the machine. Press Aim the camera.",
          { priority: 'critical', dedupeKey: 'lost' }
        );
        break;

      case 'reacquired':
        this.cue('lock');
        break;

      case 'balance-change': {
        if (Math.abs(payload.delta) < 0.01) break;
        const dir = payload.delta > 0 ? 'added' : 'removed';
        this.announce(
          `${money(Math.abs(payload.delta), this.cashMode)} ${dir}. Balance ${money(payload.credits, this.cashMode)}.`,
          { priority: 'info', dedupeKey: `bal-${payload.credits}` }
        );
        break;
      }
    }
  }

  onResult(result) {
    const alerts = this.session.record(result);

    if (result.unknown) {
      this.cue('error');
    } else if (result.win > 0) {
      this.cue(result.big ? 'bigwin' : 'win', { multiplier: result.multiplier || 1 });
    } else if (this.settings.announceLosses) {
      this.cue('loss');
    }

    const text = describeResult(result, {
      cash: this.cashMode,
      announceLosses: this.settings.announceLosses,
    });
    const spoken = this.settings.announceBalance
      ? text
      : text.replace(/\s*Balance [^.]*\./, '');
    if (spoken) {
      this.announce(spoken, { priority: 'result', interrupt: true });
    }

    // Two reasons to look again shortly after calling a spin:
    //  - real machines animate the win meter counting up, so the number read
    //    700ms after the reels stop can be short of the final total;
    //  - OCR may simply not have caught up, leaving the balance unspoken.
    // Either way, follow up rather than leave the player with a half answer.
    if (!result.unknown && (result.win > 0 || result.credits == null)) {
      this.pendingVerify = { at: performance.now() + 2600, result };
    }

    for (const alert of alerts) this.speakAlert(alert);

    const mode = this.settings.autoBoard;
    const wantBoard =
      mode === 'always' ||
      (mode === 'win' && result.win > 0) ||
      (mode === 'big' && result.big);
    if (wantBoard) this.readBoard({ automatic: true });

    this.updateStatusLine();
  }

  runVerify() {
    const { result } = this.pendingVerify;
    this.pendingVerify = null;
    const credits = this.stabilizer.get('credits');
    if (credits == null) return;

    // The balance was not readable when the spin was called; say it now.
    if (result.credits == null) {
      this.session.setCredits(credits);
      if (this.settings.announceBalance) {
        this.announce(`Balance ${money(credits, this.cashMode)}.`, {
          priority: 'info', dedupeKey: `late-bal-${credits}`,
        });
      }
      this.updateStatusLine();
      return;
    }

    const diff = credits - result.credits;
    if (Math.abs(diff) < 0.01) return;
    // The meter kept climbing: restate the real total.
    const trueWin = (result.win ?? 0) + diff;
    this.session.stats.won += diff;
    if (trueWin > this.session.stats.biggestWin) this.session.stats.biggestWin = trueWin;
    this.session.setCredits(credits);
    this.announce(
      `Correction: that paid ${money(trueWin, this.cashMode)}. Balance ${money(credits, this.cashMode)}.`,
      { priority: 'result' }
    );
    this.updateStatusLine();
  }

  speakAlert(alert) {
    this.cue('error');
    if (this.settings.haptics) vibrate('alert');
    let text;
    if (alert.type === 'loss') {
      text = `Heads up. You are down ${money(alert.amount, this.cashMode)}, which is the limit you set.`;
    } else if (alert.type === 'win') {
      text = `You are up ${money(alert.amount, this.cashMode)}, which is the goal you set.`;
    } else {
      text = `You have been playing for ${alert.minutes} minutes.`;
    }
    this.announce(text, { priority: 'critical', interrupt: true });
  }

  // --- aiming -------------------------------------------------------------

  beginAiming() {
    if (this.aiming || !this.running) return;
    this.aiming = true;
    this.lastAimAdvice = null;
    this.goodFrames = 0;
    this.audio.startSonar();
    this.announce(
      'Aiming. Turn the phone toward the machine. The tone pulses faster as you get closer.',
      { priority: 'info', interrupt: true }
    );
    this.setStatus('Aiming the camera…');
  }

  stopAiming() {
    if (!this.aiming) return;
    this.aiming = false;
    this.audio.stopSonar();
  }

  updateAim(gray, t) {
    const box = findScreen(gray, GRAY_W, GRAY_H);
    const aim = aimFromScreen(box);
    this.audio.updateSonar(aim);

    if (aim.quality > 0.78) {
      this.goodFrames += 1;
      if (this.goodFrames > 8) {
        this.stopAiming();
        this.cue('lock');
        this.announce('Got it. Hold the phone there, or prop it up.', { priority: 'info' });
        this.setStatus('Machine in frame. Play as you normally would.');
      }
      return;
    }
    this.goodFrames = 0;

    // Speak the advice only when it changes, and never more than once every
    // two seconds — the tone is the real feedback channel here.
    if (aim.advice !== this.lastAimAdvice && t - this.lastAimSpeechAt > 2000) {
      this.lastAimAdvice = aim.advice;
      this.lastAimSpeechAt = t;
      this.announce(AIM_SPEECH[aim.advice], { priority: 'chatter' });
    }
  }

  // --- board reading ------------------------------------------------------

  async readBoard({ automatic = false } = {}) {
    if (!this.running || !this.source) {
      this.announce('Press Start narrating first.', { priority: 'info' });
      return;
    }

    // Practice mode knows its own reels, no API call needed.
    if (this.sim) {
      this.announce(this.sim.describeBoard(), { priority: 'result', interrupt: !automatic });
      return;
    }

    if (!this.vision.configured) {
      const fallback = this.lastText
        ? `I can only read numbers without an API key. I can see: ${this.lastText.slice(0, 160)}`
        : 'To read the symbols I need an Anthropic API key. Open Settings and add one. Without it I can still call your wins and your balance.';
      this.announce(fallback, { priority: 'info' });
      return;
    }

    if (!automatic) this.announce('Looking…', { priority: 'info', interrupt: true });
    const image = this.source.grabJpegBase64({ maxWidth: 1100 });
    try {
      const text = await this.vision.describeBoard(image);
      this.announce(text, { priority: 'result', interrupt: !automatic });
    } catch (err) {
      this.cue('error');
      this.announce(err.message, { priority: 'critical' });
    }
  }

  // --- UI -----------------------------------------------------------------

  bindUi() {
    const s = this.settings;

    $('btn-start').addEventListener('click', () => {
      if (this.running) this.stop();
      else this.start({ practice: false });
    });

    $('btn-practice').addEventListener('click', () => {
      if (this.running) this.stop();
      this.start({ practice: true });
    });

    $('btn-spin').addEventListener('click', () => this.practiceSpin());
    $('btn-board').addEventListener('click', () => this.readBoard());
    $('btn-aim').addEventListener('click', () => this.beginAiming());
    $('btn-quiet').addEventListener('click', () => {
      this.narrator.shutUp();
      this.audio.stopSonar();
      this.aiming = false;
    });

    $('btn-status').addEventListener('click', () => {
      const sum = this.session.summary();
      if (!sum.spins) {
        this.announce('No spins yet this session.', { priority: 'result', interrupt: true });
        return;
      }
      this.announce(describeSession(sum, this.cashMode), { priority: 'result', interrupt: true });
    });

    $('btn-repeat').addEventListener('click', () => {
      const last = this.lastAnnouncement || 'Nothing to repeat yet.';
      this.narrator.shutUp();
      this.announce(last, { priority: 'result' });
    });

    $('btn-reset-session').addEventListener('click', () => {
      this.session = new SessionTracker(this.limitOpts());
      this.session.start(this.stabilizer.get('credits'));
      this.announce('Fresh session started.', { priority: 'info' });
    });

    $('btn-test-voice').addEventListener('click', async () => {
      await this.audio.resume();
      this.cue('win', { multiplier: 10 });
      this.announce('This is how a win sounds. Big win! 40 credits. Balance 1,240.', {
        priority: 'result', interrupt: true,
      });
    });

    $('btn-test-key').addEventListener('click', () => this.testKey());

    // --- settings controls
    bindSelect($('set-route'), s.route, (v) => { s.route = v; this.applySettings(); this.save(); });
    bindRange($('set-rate'), $('set-rate-out'), s.rate, (v) => { s.rate = v; this.applySettings(); this.save(); });
    bindRange($('set-volume'), $('set-volume-out'), s.volume * 100, (v) => {
      s.volume = v / 100; this.applySettings(); this.save();
    }, (v) => Math.round(v));
    bindCheck($('set-losses'), s.announceLosses, (v) => { s.announceLosses = v; this.save(); });
    bindCheck($('set-earcons'), s.earcons, (v) => { s.earcons = v; this.applySettings(); this.save(); });
    bindCheck($('set-haptics'), s.haptics, (v) => { s.haptics = v; this.save(); });
    bindCheck($('set-balance'), s.announceBalance, (v) => { s.announceBalance = v; this.save(); });
    bindSelect($('set-autoboard'), s.autoBoard, (v) => { s.autoBoard = v; this.save(); });
    bindNumber($('set-loss-limit'), s.lossLimit, (v) => { s.lossLimit = v; this.applySettings(); this.save(); });
    bindNumber($('set-win-goal'), s.winGoal, (v) => { s.winGoal = v; this.applySettings(); this.save(); });
    bindNumber($('set-time-limit'), s.timeLimitMin, (v) => { s.timeLimitMin = v; this.applySettings(); this.save(); });
    bindText($('set-key'), s.apiKey, (v) => { s.apiKey = v; this.applySettings(); this.save(); });

    const modelSel = $('set-model');
    for (const m of MODELS) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      modelSel.appendChild(opt);
    }
    bindSelect(modelSel, s.model, (v) => { s.model = v; this.applySettings(); this.save(); });

    bindCheck($('set-torch'), s.torch, async (v) => {
      s.torch = v; this.save();
      const ok = await this.camera.setTorch(v);
      if (!ok && v) this.announce('This phone will not let the browser control the flashlight.', { priority: 'info' });
    });
    bindCheck($('set-preview'), s.preview, (v) => { s.preview = v; this.applySettings(); this.save(); });
    bindSelect($('set-camera'), s.cameraId, (v) => { s.cameraId = v; this.save(); });

    this.populateVoices();
    if (window.speechSynthesis) {
      window.speechSynthesis.addEventListener?.('voiceschanged', () => this.populateVoices());
    }

    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  practiceSpin() {
    if (!this.sim) return;
    if (!this.sim.spin()) {
      this.announce('Out of practice credits. Press Start practice mode again for a fresh 500.', {
        priority: 'info',
      });
    }
  }

  onKey(e) {
    // Never hijack typing in the settings fields.
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    const key = e.key.toLowerCase();
    const map = {
      s: 'btn-start', b: 'btn-board', a: 'btn-aim',
      h: 'btn-status', r: 'btn-repeat', q: 'btn-quiet', p: 'btn-practice',
    };
    if (key === ' ' || e.code === 'Space') {
      if (this.sim) { e.preventDefault(); this.practiceSpin(); }
      return;
    }
    if (map[key]) {
      e.preventDefault();
      $(map[key]).click();
    }
  }

  populateVoices() {
    const sel = $('set-voice');
    const voices = this.narrator.listVoices();
    if (!voices.length) return;
    sel.innerHTML = '';
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = String(v.index);
      opt.textContent = `${v.name} (${v.lang})${v.local ? ' — works offline' : ''}`;
      sel.appendChild(opt);
    }
    if (this.settings.voiceIndex != null) sel.value = String(this.settings.voiceIndex);
    sel.onchange = () => {
      this.settings.voiceIndex = Number(sel.value);
      this.narrator.setVoiceByIndex(this.settings.voiceIndex);
      this.save();
      this.announce('This is the new voice.', { priority: 'info', interrupt: true });
    };
  }

  async refreshCameraList() {
    const sel = $('set-camera');
    const cams = await this.camera.listCameras();
    if (!cams.length) return;
    sel.innerHTML = '<option value="">Back camera (automatic)</option>';
    for (const c of cams) {
      const opt = document.createElement('option');
      opt.value = c.deviceId;
      opt.textContent = c.label;
      sel.appendChild(opt);
    }
    sel.value = this.settings.cameraId || '';
  }

  async testKey() {
    if (!this.vision.configured) {
      this.announce('No key entered yet.', { priority: 'info' });
      return;
    }
    if (!this.running || !this.source) {
      this.announce('Start narrating or practice mode first, so there is a picture to send.', {
        priority: 'info',
      });
      return;
    }
    this.announce('Checking the key…', { priority: 'info' });
    try {
      await this.vision.describeBoard(this.source.grabJpegBase64({ maxWidth: 600 }));
      this.cue('lock');
      this.announce('The key works. I can read the symbols now.', { priority: 'result' });
    } catch (err) {
      this.cue('error');
      this.announce(err.message, { priority: 'critical' });
    }
  }

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
    });
  }
}

// --- small binding helpers -------------------------------------------------

function bindSelect(el, value, onChange) {
  if (!el) return;
  if (value != null) el.value = value;
  el.addEventListener('change', () => onChange(el.value));
}

function bindCheck(el, value, onChange) {
  if (!el) return;
  el.checked = !!value;
  el.addEventListener('change', () => onChange(el.checked));
}

function bindRange(el, out, value, onChange, fmt = (v) => v) {
  if (!el) return;
  el.value = String(value);
  if (out) out.textContent = String(fmt(value));
  el.addEventListener('input', () => {
    const v = Number(el.value);
    if (out) out.textContent = String(fmt(v));
    onChange(v);
  });
}

function bindNumber(el, value, onChange) {
  if (!el) return;
  if (value != null) el.value = String(value);
  el.addEventListener('change', () => {
    const raw = el.value.trim();
    onChange(raw === '' ? null : Number(raw));
  });
}

function bindText(el, value, onChange) {
  if (!el) return;
  el.value = value || '';
  el.addEventListener('change', () => onChange(el.value.trim()));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

window.app = new App();
