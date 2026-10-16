/**
 * engine.js — the spin state machine.
 *
 * Consumes a stream of samples from the camera pipeline and decides, in real
 * time, when a spin started, when the reels stopped, and what the outcome was.
 * Pure and deterministic: feed it samples, get events. No DOM, no camera, so
 * the whole thing is unit-testable and can be replayed from a recording.
 *
 * Outcome maths
 * -------------
 * A slot deducts the bet, spins, then adds any win. So across one spin:
 *     net = creditsAfter - creditsBefore
 *     win = net + bet
 * A losing spin has net === -bet and therefore win === 0. When the machine
 * shows its own WIN/PAID meter we prefer that number and use the credit maths
 * only as a cross-check, because the WIN meter is authoritative.
 */

export const STATE = {
  IDLE: 'idle',
  SPINNING: 'spinning',
  SETTLING: 'settling',
};

export const DEFAULTS = {
  spinStartMotion: 0.10,   // fraction of pixels changing that means "reels moving"
  spinStopMotion: 0.035,   // below this the reels are considered stopped
  spinConfirmMs: 220,      // motion must persist this long to count as a spin
  settleMs: 700,           // stillness required before we call the result
  maxSpinMs: 45000,        // safety valve for a stuck state
  bigWinMultiplier: 15,    // win >= bet * this is announced as a big win
  staleReadMs: 6000,       // no readable meters for this long => lost track
};

const BONUS_WORDS = /\b(bonus|free\s*(games?|spins?)|feature|pick|wheel|respin|hold\s*and\s*spin|jackpot)\b/i;

export class SpinEngine {
  /**
   * @param {object} opts    overrides for DEFAULTS
   * @param {function} emit  called with (eventName, payload)
   */
  constructor(opts = {}, emit = () => {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.emit = emit;
    this.state = STATE.IDLE;
    this.motionSince = null;     // when motion first crossed the start threshold
    this.quietSince = null;      // when motion last dropped below the stop threshold
    this.spinStartedAt = null;
    this.creditsBefore = null;
    this.betAtStart = null;
    this.winMeterAtStart = null;
    this.lastCredits = null;
    this.lastBet = null;
    this.lastGoodReadAt = null;
    this.staleAnnounced = false;
    this.spinCount = 0;
    this.sawBonusText = false;
    this.awaitQuiet = false;
  }

  /** Reset spin tracking but keep learned meter values. */
  resetSpin() {
    this.state = STATE.IDLE;
    this.motionSince = null;
    this.quietSince = null;
    this.spinStartedAt = null;
    this.creditsBefore = null;
    this.betAtStart = null;
    this.winMeterAtStart = null;
    this.sawBonusText = false;
  }

  /**
   * Feed one sample.
   * @param {{t:number, motion:number, meters?:{credits:?number,bet:?number,win:?number,text?:string}}} sample
   */
  push(sample) {
    const o = this.opts;
    const t = sample.t;
    const motion = sample.motion ?? 0;
    const m = sample.meters || {};

    // --- track meter freshness -------------------------------------------
    if (m.credits != null || m.bet != null) {
      this.lastGoodReadAt = t;
      if (this.staleAnnounced) {
        this.staleAnnounced = false;
        this.emit('reacquired', { t });
      }
    } else if (
      this.lastGoodReadAt != null &&
      t - this.lastGoodReadAt > o.staleReadMs &&
      !this.staleAnnounced
    ) {
      this.staleAnnounced = true;
      this.emit('lost-track', { t, since: this.lastGoodReadAt });
    }

    if (m.text && BONUS_WORDS.test(m.text)) this.sawBonusText = true;

    // --- balance changes while idle (cash in, ticket in, hand pay) --------
    //
    // Only trusted while the frame is genuinely still. A machine deducts the
    // bet on the same frame the reels start moving, so a credit reading taken
    // once motion has begun is already post-deduction. Folding that into
    // "credits before the spin" would silently inflate every single win, so
    // the pre-spin balance is frozen the moment motion appears.
    const quiet = motion < o.spinStartMotion;
    if (this.state === STATE.IDLE && m.credits != null && quiet) {
      if (this.lastCredits != null && m.credits !== this.lastCredits) {
        const delta = m.credits - this.lastCredits;
        // A drop of exactly one bet is the machine taking the wager, not the
        // player cashing out — never announce that as a balance change.
        const looksLikeWager = this.lastBet != null && Math.abs(delta + this.lastBet) < 1e-9;
        if (!looksLikeWager) this.emit('balance-change', { t, credits: m.credits, delta });
      }
      this.lastCredits = m.credits;
    } else if (m.credits != null && this.lastCredits == null) {
      this.lastCredits = m.credits;
    }
    if (m.bet != null) this.lastBet = m.bet;

    // --- state machine ----------------------------------------------------
    switch (this.state) {
      case STATE.IDLE: {
        if (motion < o.spinStopMotion) this.awaitQuiet = false;
        if (motion >= o.spinStartMotion && !this.awaitQuiet) {
          if (this.motionSince == null) this.motionSince = t;
          if (t - this.motionSince >= o.spinConfirmMs) this.beginSpin(t, m);
        } else {
          this.motionSince = null;
        }
        break;
      }

      case STATE.SPINNING: {
        if (motion < o.spinStopMotion) {
          this.state = STATE.SETTLING;
          this.quietSince = t;
        } else if (t - this.spinStartedAt > o.maxSpinMs) {
          // Something is wrong (camera moved, machine idle-animating). Bail out
          // quietly rather than announcing a bogus result.
          this.emit('spin-abandoned', { t });
          this.resetSpin();
          // Do not immediately re-trigger on the same continuous motion; wait
          // for the scene to actually settle first.
          this.awaitQuiet = true;
        }
        break;
      }

      case STATE.SETTLING: {
        if (motion >= o.spinStartMotion) {
          // Reels restarted: anticipation spin, re-spin, or a bonus sequence.
          this.state = STATE.SPINNING;
          this.quietSince = null;
        } else if (t - this.quietSince >= o.settleMs) {
          this.finishSpin(t, m);
        }
        break;
      }
    }
    return this.state;
  }

  beginSpin(t, m) {
    this.state = STATE.SPINNING;
    this.spinStartedAt = t;
    this.creditsBefore = this.lastCredits;
    this.betAtStart = m.bet ?? this.lastBet;
    this.winMeterAtStart = m.win ?? null;
    this.sawBonusText = false;
    this.spinCount += 1;
    this.emit('spin-start', {
      t,
      spin: this.spinCount,
      credits: this.creditsBefore,
      bet: this.betAtStart,
    });
  }

  finishSpin(t, m) {
    const o = this.opts;
    const creditsAfter = m.credits ?? this.lastCredits;
    const creditsBefore = this.creditsBefore;
    const bet = this.betAtStart ?? this.lastBet ?? null;
    const winMeter = m.win ?? null;

    let net = null;
    if (creditsAfter != null && creditsBefore != null) net = creditsAfter - creditsBefore;

    let win = null;
    let source = 'unknown';

    if (winMeter != null && winMeter !== this.winMeterAtStart) {
      // The machine told us directly.
      win = winMeter;
      source = 'win-meter';
    } else if (net != null && bet != null) {
      win = Math.max(0, Math.round((net + bet) * 100) / 100);
      source = 'credit-delta';
    } else if (net != null && net > 0) {
      win = net;
      source = 'credit-rise';
    } else if (winMeter != null) {
      win = winMeter;
      source = 'win-meter-static';
    }

    if (creditsAfter != null) this.lastCredits = creditsAfter;

    const durationMs = t - this.spinStartedAt;
    const multiplier = win != null && bet ? win / bet : null;

    const result = {
      t,
      spin: this.spinCount,
      win,
      net,
      bet,
      credits: creditsAfter,
      source,
      multiplier,
      durationMs,
      bonus: this.sawBonusText || durationMs > 12000,
      big: multiplier != null && multiplier >= o.bigWinMultiplier,
      unknown: win == null,
    };

    this.resetSpin();
    this.emit('result', result);
    return result;
  }
}
