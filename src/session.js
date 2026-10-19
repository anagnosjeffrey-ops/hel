/**
 * session.js — running totals for one sitting at a machine.
 *
 * A sighted player glances at the credit meter whenever they want. This is the
 * equivalent: an always-current summary the player can ask for by voice/button
 * at any moment, plus optional limits that speak up on their own.
 *
 * Pure data + arithmetic; persistence is injected so it is testable.
 */

export const emptyStats = () => ({
  startedAt: null,
  spins: 0,
  wins: 0,
  losses: 0,
  wagered: 0,
  won: 0,
  biggestWin: 0,
  biggestWinSpin: null,
  bonuses: 0,
  startCredits: null,
  startCreditsTrusted: false,
  playBegan: false,
  credits: null,
  unreadable: 0,
  cash: false,
});

export class SessionTracker {
  /**
   * @param {object} opts
   * @param {number|null} opts.lossLimit   speak a warning once losses reach this
   * @param {number|null} opts.winGoal     speak once profit reaches this
   * @param {number|null} opts.timeLimitMin speak once the session runs this long
   * @param {function} opts.now            clock injection for tests
   */
  constructor(opts = {}) {
    this.opts = {
      lossLimit: null,
      winGoal: null,
      timeLimitMin: null,
      now: () => Date.now(),
      ...opts,
    };
    this.stats = emptyStats();
    this.firedAlerts = new Set();
  }

  start(credits = null) {
    this.stats = emptyStats();
    this.stats.startedAt = this.opts.now();
    this.stats.startCredits = credits;
    this.stats.startCreditsTrusted = credits != null;
    this.stats.credits = credits;
    this.firedAlerts.clear();
  }

  /**
   * Called the moment the reels start turning. After this point a balance
   * read for the first time is already post-wager and cannot serve as the
   * session's starting point.
   */
  noteSpinStart() {
    this.stats.playBegan = true;
  }

  setCredits(credits) {
    if (credits == null) return;
    if (this.stats.startedAt == null) this.start(credits);
    if (this.stats.startCredits == null) {
      this.stats.startCredits = credits;
      // Only a balance seen *before* the first spin is a true starting point.
      // If the app did not get a clean read until after play began, the
      // opening balance is already short by at least one bet, and treating it
      // as the baseline would report a losing session as breaking even.
      this.stats.startCreditsTrusted = !this.stats.playBegan;
    }
    this.stats.credits = credits;
  }

  /** Record a finished spin. Returns any limit alerts triggered by it. */
  record(result) {
    // start() swaps in a fresh stats object, so the reference must be taken
    // after it, not before, or every total below lands on a discarded object.
    const bootstrapped = this.stats.startedAt == null;
    if (bootstrapped) this.start(result.credits ?? null);
    const s = this.stats;
    // A recorded spin means play is under way, whether or not we saw it start.
    s.playBegan = true;
    // A session that begins with a finished spin never saw a pre-wager
    // balance, so that balance cannot anchor the net figure.
    if (bootstrapped) s.startCreditsTrusted = false;
    s.spins += 1;
    if (result.bet != null) s.wagered += result.bet;
    if (result.credits != null) this.setCredits(result.credits);
    if (result.bonus) s.bonuses += 1;

    if (result.unknown || result.win == null) {
      s.unreadable += 1;
    } else if (result.win > 0) {
      s.wins += 1;
      s.won += result.win;
      if (result.win > s.biggestWin) {
        s.biggestWin = result.win;
        s.biggestWinSpin = s.spins;
      }
    } else {
      s.losses += 1;
    }
    return this.checkLimits();
  }

  /**
   * Net position: positive means ahead. Real credit movement is the truth
   * when we have a trustworthy starting balance; otherwise fall back to the
   * spins we actually scored.
   */
  get net() {
    const s = this.stats;
    if (s.startCreditsTrusted && s.startCredits != null && s.credits != null) {
      return round2(s.credits - s.startCredits);
    }
    return round2(s.won - s.wagered);
  }

  get elapsedMs() {
    if (this.stats.startedAt == null) return 0;
    return this.opts.now() - this.stats.startedAt;
  }

  get hitRate() {
    const played = this.stats.wins + this.stats.losses;
    return played ? this.stats.wins / played : 0;
  }

  /** Alerts fire at most once each per session. */
  checkLimits() {
    const alerts = [];
    const { lossLimit, winGoal, timeLimitMin } = this.opts;
    const net = this.net;

    if (lossLimit != null && net <= -Math.abs(lossLimit) && !this.firedAlerts.has('loss')) {
      this.firedAlerts.add('loss');
      alerts.push({ type: 'loss', amount: Math.abs(net), limit: Math.abs(lossLimit) });
    }
    if (winGoal != null && net >= Math.abs(winGoal) && !this.firedAlerts.has('win')) {
      this.firedAlerts.add('win');
      alerts.push({ type: 'win', amount: net, goal: Math.abs(winGoal) });
    }
    if (timeLimitMin != null && this.elapsedMs >= timeLimitMin * 60000 && !this.firedAlerts.has('time')) {
      this.firedAlerts.add('time');
      alerts.push({ type: 'time', minutes: Math.round(this.elapsedMs / 60000) });
    }
    return alerts;
  }

  /** Everything needed to build a spoken summary. */
  summary() {
    const s = this.stats;
    return {
      spins: s.spins,
      wins: s.wins,
      losses: s.losses,
      wagered: round2(s.wagered),
      won: round2(s.won),
      net: round2(this.net),
      credits: s.credits,
      biggestWin: s.biggestWin,
      biggestWinSpin: s.biggestWinSpin,
      bonuses: s.bonuses,
      unreadable: s.unreadable,
      hitRate: this.hitRate,
      minutes: Math.round(this.elapsedMs / 60000),
      cash: s.cash,
    };
  }

  toJSON() {
    return { stats: this.stats, alerts: [...this.firedAlerts] };
  }

  static fromJSON(data, opts) {
    const t = new SessionTracker(opts);
    if (data && data.stats) t.stats = { ...emptyStats(), ...data.stats };
    if (data && data.alerts) t.firedAlerts = new Set(data.alerts);
    return t;
  }
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Format an amount for speech: "12 credits" / "$12.50". */
export function money(amount, cash) {
  if (amount == null) return 'unknown';
  const v = round2(amount);
  if (cash) return `$${v.toFixed(2)}`;
  if (Number.isInteger(v)) return `${v} credit${v === 1 ? '' : 's'}`;
  return `${v} credits`;
}

/** Build the sentence spoken after every spin. */
export function describeResult(result, { cash = false, announceLosses = true } = {}) {
  if (result.unknown) {
    return "I could not read the result. Point the camera at the screen and I'll try again.";
  }
  const parts = [];
  if (result.win > 0) {
    if (result.big) parts.push('Big win!');
    else parts.push('Win.');
    parts.push(`${money(result.win, cash)}.`);
    if (result.multiplier != null && result.multiplier >= 2) {
      parts.push(`${trimNum(result.multiplier)} times your bet.`);
    }
  } else if (announceLosses) {
    parts.push('No win.');
  }
  if (result.bonus) parts.push('Bonus feature.');
  if (result.credits != null) parts.push(`Balance ${money(result.credits, cash)}.`);
  return parts.join(' ').trim();
}

/** Build the sentence spoken when the player asks for a session summary. */
export function describeSession(sum, cash = false) {
  const dir = sum.net > 0 ? 'up' : sum.net < 0 ? 'down' : 'even';
  const bits = [
    `${sum.spins} spin${sum.spins === 1 ? '' : 's'} over ${sum.minutes} minute${sum.minutes === 1 ? '' : 's'}.`,
    `You've wagered ${money(sum.wagered, cash)} and won ${money(sum.won, cash)}.`,
    dir === 'even' ? "You're even." : `You're ${dir} ${money(Math.abs(sum.net), cash)}.`,
  ];
  if (sum.credits != null) bits.push(`Balance ${money(sum.credits, cash)}.`);
  if (sum.biggestWin > 0) bits.push(`Biggest win ${money(sum.biggestWin, cash)}.`);
  if (sum.wins + sum.losses > 0) bits.push(`You've hit on ${Math.round(sum.hitRate * 100)} percent of spins.`);
  return bits.join(' ');
}

function trimNum(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
