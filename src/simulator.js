/**
 * simulator.js — a fake slot machine, drawn on a canvas.
 *
 * Why this exists: a blind player cannot check whether the app "looks like
 * it's working" before relying on it at a machine. Practice mode replaces the
 * camera with a simulated machine and runs the *identical* pipeline — motion
 * detection, OCR, spin engine, narration. If the app narrates practice mode
 * correctly, the player knows the narration itself is sound, and anything
 * that goes wrong at a real machine is aiming or lighting, not the app.
 *
 * It deliberately exposes the same interface as Camera, so app.js does not
 * care which one it is reading from.
 */

const SYMBOLS = ['SEVEN', 'BAR', 'CHERRY', 'BELL', 'PLUM', 'STAR', 'CROWN'];
const PAYS = { SEVEN: 50, CROWN: 25, BELL: 15, STAR: 12, BAR: 10, PLUM: 6, CHERRY: 4 };

export class SlotSimulator {
  constructor({ width = 960, height = 640, startCredits = 500, bet = 5 } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.analysisCanvas = document.createElement('canvas');
    this.analysisCtx = this.analysisCanvas.getContext('2d', { willReadFrequently: true });
    this.analysisWidth = 320;

    this.credits = startCredits;
    this.bet = bet;
    this.win = 0;
    this.reels = [
      [sym(), sym(), sym()],
      [sym(), sym(), sym()],
      [sym(), sym(), sym()],
    ];
    this.spinning = false;
    this.spinUntil = 0;
    this.offsets = [0, 0, 0];
    this.stopTimes = [0, 0, 0];
    this.running = true;
    this.torchAvailable = false;
    this.lastOutcome = null;
    this._raf = null;
    this._draw();
  }

  /** Start a spin. Resolves when the reels have stopped and credits settled. */
  spin() {
    if (this.spinning) return false;
    if (this.credits < this.bet) return false;
    this.spinning = true;
    this.credits -= this.bet;
    this.win = 0;
    const now = performance.now();
    // Reels stop left to right, like a real machine.
    this.stopTimes = [now + 1200, now + 1800, now + 2500 + Math.random() * 900];
    this.spinUntil = this.stopTimes[2];
    this._loop();
    return true;
  }

  _loop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    const step = () => {
      const now = performance.now();
      let anyMoving = false;
      for (let r = 0; r < 3; r++) {
        if (now < this.stopTimes[r]) {
          anyMoving = true;
          this.offsets[r] = (this.offsets[r] + 42) % 120;
          if (this.offsets[r] < 42) {
            this.reels[r] = [sym(), this.reels[r][0], this.reels[r][1]];
          }
        } else {
          this.offsets[r] = 0;
        }
      }
      this._draw();
      if (anyMoving) {
        this._raf = requestAnimationFrame(step);
      } else if (this.spinning) {
        this.spinning = false;
        this._settle();
        this._draw();
      }
    };
    this._raf = requestAnimationFrame(step);
  }

  _settle() {
    const mid = [this.reels[0][1], this.reels[1][1], this.reels[2][1]];
    let win = 0;
    if (mid[0] === mid[1] && mid[1] === mid[2]) {
      win = PAYS[mid[0]] * this.bet / 5;
    } else if (mid[0] === mid[1] || mid[1] === mid[2]) {
      win = mid[1] === 'CHERRY' ? this.bet : 0;
    }
    if (mid.every((s) => s === 'CHERRY')) win = PAYS.CHERRY * this.bet;
    win = Math.round(win);
    this.win = win;
    this.credits += win;
    this.lastOutcome = { symbols: mid, win, credits: this.credits, bet: this.bet };
  }

  /** A spoken board readout, for practice mode's "read the board" button. */
  describeBoard() {
    const rows = ['Top row', 'Middle row', 'Bottom row'];
    const lines = rows.map((label, i) => {
      const row = [this.reels[0][i], this.reels[1][i], this.reels[2][i]].map(pretty);
      return `${label}: ${row.join(', ')}.`;
    });
    let text = lines.join(' ');
    if (this.win > 0) text += ` Winning line pays ${this.win}.`;
    text += ` Credits ${this.credits}. Bet ${this.bet}.`;
    return text;
  }

  _draw() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, W, H);

    // Reel window
    const rw = 240;
    const rh = 360;
    const top = 60;
    const gap = 24;
    const left = (W - (rw * 3 + gap * 2)) / 2;

    for (let r = 0; r < 3; r++) {
      const x = left + r * (rw + gap);
      ctx.fillStyle = '#f4f4f0';
      ctx.fillRect(x, top, rw, rh);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, top, rw, rh);
      ctx.clip();
      ctx.fillStyle = '#101018';
      ctx.font = 'bold 46px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < 3; i++) {
        const y = top + 60 + i * 120 - this.offsets[r];
        ctx.fillText(this.reels[r][i], x + rw / 2, y);
      }
      ctx.restore();
      ctx.strokeStyle = '#8899aa';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, top, rw, rh);
    }

    // Payline marker across the middle row
    ctx.strokeStyle = this.win > 0 ? '#ffd23f' : '#33384a';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(left - 14, top + 180);
    ctx.lineTo(left + rw * 3 + gap * 2 + 14, top + 180);
    ctx.stroke();

    // Meters — plain labelled text, exactly like a real machine, so the same
    // label-anchored OCR path is exercised in practice mode.
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`CREDIT ${this.credits}`, 50, H - 120);
    ctx.fillText(`BET ${this.bet}`, 50, H - 60);
    ctx.textAlign = 'right';
    ctx.fillText(`WIN ${this.win}`, W - 50, H - 60);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#9aa6c0';
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillText('PRACTICE MACHINE', 50, 40);
  }

  // --- Camera-compatible interface ---------------------------------------

  grabAnalysisFrame() {
    const w = this.analysisWidth;
    const h = Math.round((this.canvas.height / this.canvas.width) * w);
    if (this.analysisCanvas.width !== w) {
      this.analysisCanvas.width = w;
      this.analysisCanvas.height = h;
    }
    this.analysisCtx.drawImage(this.canvas, 0, 0, w, h);
    return this.analysisCtx.getImageData(0, 0, w, h);
  }

  grabCapture() {
    // Hand back a copy: the OCR path binarizes what it is given in place, and
    // scribbling on the live canvas would wreck the display it reads from.
    if (!this._capture) this._capture = document.createElement('canvas');
    if (this._capture.width !== this.canvas.width) {
      this._capture.width = this.canvas.width;
      this._capture.height = this.canvas.height;
    }
    const ctx = this._capture.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.canvas, 0, 0);
    return this._capture;
  }

  grabJpegBase64({ quality = 0.72 } = {}) {
    const url = this.canvas.toDataURL('image/jpeg', quality);
    return url.slice(url.indexOf(',') + 1);
  }

  async setTorch() { return false; }
  async toggleTorch() { return false; }
  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.running = false;
  }
}

function sym() {
  return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
}

function pretty(s) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
