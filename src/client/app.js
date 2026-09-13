import { ApiError, api, feedUrl, getApiKey, serverNow, setApiKey } from './api.js';
import { UploadQueue } from './uploads.js';
import { vinFeedback } from './vin.js';

/**
 * The capture app.
 *
 * The whole design target is a used-car manager standing beside a customer with
 * a trade the store does not retail. Everything here is shaped by that: the
 * photos come first because they are the slow part, the uploads run while the
 * details are typed, and the draft survives a locked phone.
 */

/** The required set from `domain/vehicle.ts`, with what to actually shoot. */
const ANGLES = [
  {
    id: 'front_34',
    label: 'Front 3/4',
    hint: 'Stand at the corner — front and one side in frame.',
  },
  { id: 'rear_34', label: 'Rear 3/4', hint: 'Opposite corner.' },
  { id: 'driver_side', label: 'Driver side', hint: 'Square on, whole car.' },
  { id: 'passenger_side', label: 'Passenger side', hint: 'Square on, whole car.' },
  { id: 'interior_front', label: 'Front interior', hint: 'Dash and both front seats.' },
  { id: 'odometer', label: 'Odometer', hint: 'Cluster lit, mileage readable.' },
  { id: 'engine_bay', label: 'Engine bay', hint: 'Hood up.' },
  { id: 'vin_plate', label: 'VIN plate', hint: 'Door jamb or dash.' },
];

const DISCLOSURES = [
  { id: 'frame_damage', label: 'Frame damage', needsPhoto: true },
  { id: 'prior_paint', label: 'Prior paint', needsPhoto: true },
  { id: 'mechanical_issue', label: 'Mechanical issue', needsPhoto: true },
  { id: 'flood', label: 'Flood', needsPhoto: true },
  { id: 'warning_light', label: 'Warning light', needsPhoto: false },
  { id: 'odometer_discrepancy', label: 'Odometer discrepancy', needsPhoto: false },
  { id: 'aftermarket_modification', label: 'Aftermarket mods', needsPhoto: false },
  { id: 'missing_key', label: 'Missing key', needsPhoto: false },
];

/** Mirrors `domain/fees.ts`, so the quote is on screen before anyone commits. */
const BUYER_FEE_TIERS = [
  { floor: 2_000_000, fee: 44_900 },
  { floor: 1_000_000, fee: 34_900 },
  { floor: 500_000, fee: 24_900 },
  { floor: 0, fee: 14_900 },
];
const SELLER_FEE = 9_900;

const buyerFeeFor = (cents) => BUYER_FEE_TIERS.find((tier) => cents >= tier.floor).fee;

const DRAFT_STORAGE = 'autobank.draft';
const SCREENS = ['photos', 'details', 'money', 'review'];

const el = {
  screen: document.getElementById('screen'),
  title: document.getElementById('bar-title'),
  step: document.getElementById('bar-step'),
  footer: document.getElementById('footer'),
  back: document.getElementById('back'),
  next: document.getElementById('next'),
  toast: document.getElementById('toast'),
};

const queue = new UploadQueue();

let state = {
  screen: getApiKey() === null ? 'key' : 'photos',
  draft: loadDraft(),
  listing: null,
  live: null,
  problems: [],
};

// ------------------------------------------------------------------ helpers

function emptyDraft() {
  return {
    vin: '',
    year: '',
    make: '',
    model: '',
    trim: '',
    odometerMiles: '',
    keyCount: '2',
    titleStatus: 'clean',
    disclosures: {},
    walkPrice: '',
    startingBid: '',
    photoUrls: {},
  };
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE);
    return raw === null ? emptyDraft() : { ...emptyDraft(), ...JSON.parse(raw) };
  } catch {
    return emptyDraft();
  }
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_STORAGE, JSON.stringify(state.draft));
  } catch {
    /* private browsing — the draft just will not survive a reload */
  }
}

function clearDraft() {
  state.draft = emptyDraft();
  queue.clear();
  try {
    localStorage.removeItem(DRAFT_STORAGE);
  } catch {
    /* nothing to clean up */
  }
}

const money = (cents) =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  });

/**
 * A whole number as typed by a person, or null when the field is unusable.
 *
 * `Number('')` is 0, which would quietly turn a blank odometer into a car
 * advertised at zero miles — to dealers bidding sight-unseen, on a fifteen
 * minute clock, with no chance to look at it first.
 */
function parseInteger(input) {
  const cleaned = String(input).trim().replace(/,/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value : null;
}

/** Dollars typed by a person become whole cents, or null if unusable. */
function dollarsToCents(input) {
  const cleaned = String(input).replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 3200);
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

// ------------------------------------------------------------- validation

/** Mirrors the server's rules so nothing is posted that will bounce. */
function findProblems() {
  const problems = [];
  const d = state.draft;

  const captured = new Set(queue.uploaded().map((entry) => entry.angle));
  for (const angle of ANGLES) {
    if (!captured.has(angle.id)) problems.push(`Missing the ${angle.label.toLowerCase()} photo.`);
  }

  const needsDamagePhoto = DISCLOSURES.filter((x) => x.needsPhoto).some((x) => d.disclosures[x.id]);
  if (needsDamagePhoto && !captured.has('damage')) {
    problems.push('Disclosed damage needs at least one damage photo.');
  }

  const vin = vinFeedback(d.vin);
  if (vin === null || vin.tone === 'bad' || String(d.vin).length < 17) {
    problems.push('Enter a full 17-character VIN.');
  }
  if (d.make.trim() === '') problems.push('Enter the make.');
  if (d.model.trim() === '') problems.push('Enter the model.');

  const year = parseInteger(d.year);
  const latestYear = new Date().getUTCFullYear() + 2;
  if (year === null || year < 1900 || year > latestYear) problems.push('Enter the model year.');

  if (parseInteger(d.odometerMiles) === null) problems.push('Enter the odometer reading.');
  if (parseInteger(d.keyCount) === null) problems.push('Enter how many keys come with it.');

  const starting = dollarsToCents(d.startingBid);
  const walk = dollarsToCents(d.walkPrice);
  if (starting === null) problems.push('Set an opening bid.');
  if (walk !== null && starting !== null && walk < starting) {
    problems.push('Your number has to be at or above the opening bid.');
  }

  return problems;
}

// ----------------------------------------------------------------- screens

function renderKey() {
  el.footer.hidden = true;
  el.title.textContent = 'Sign in';
  el.step.textContent = '';
  el.screen.innerHTML = `
    <h2>Dealer key</h2>
    <p class="hint">Paste the key issued to your rooftop. It stays on this phone.</p>
    <label>API key
      <input id="key-input" type="password" autocomplete="off" placeholder="ab_…" />
    </label>
    <button class="btn btn-primary btn-wide" id="key-save" type="button">Continue</button>
  `;

  const input = document.getElementById('key-input');
  document.getElementById('key-save').addEventListener('click', async () => {
    const value = input.value.trim();
    if (value === '') return toast('Paste your dealer key first.');

    setApiKey(value);
    try {
      await api.verifyKey();
      go('photos');
    } catch (error) {
      setApiKey(null);
      toast(
        error instanceof ApiError && error.status === 401
          ? 'That key was not recognized.'
          : 'Could not reach AutoBank.',
      );
    }
  });
}

function renderPhotos() {
  const done = queue.uploaded().length;
  el.title.textContent = 'Photograph the car';
  el.step.textContent = `${done} of ${ANGLES.length}`;
  el.footer.hidden = false;
  el.back.hidden = true;
  el.next.textContent = 'Next: details';
  el.next.disabled = done < ANGLES.length;

  const optional = queue.get('damage');
  el.screen.innerHTML = `
    <h2>Eight shots</h2>
    <p class="hint">Tap a tile to shoot it. Uploads run in the background while you keep going.</p>
    <div class="grid" id="tiles"></div>
    <div class="card" style="margin-top:14px">
      <h3>Damage photo${optional ? '' : ' (only if there is damage)'}</h3>
      <div class="grid"><div id="damage-tile"></div></div>
    </div>
    ${queue.failedCount() > 0 ? '<button class="btn btn-ghost btn-wide" id="retry" type="button">Retry failed uploads</button>' : ''}
  `;

  const tiles = document.getElementById('tiles');
  for (const angle of ANGLES) tiles.append(buildTile(angle));
  document
    .getElementById('damage-tile')
    .append(buildTile({ id: 'damage', label: 'Damage', hint: 'Show what you disclosed.' }));

  document.getElementById('retry')?.addEventListener('click', () => {
    queue.retryFailed();
    toast('Retrying…');
  });
}

function buildTile(angle) {
  const job = queue.get(angle.id);
  const state_ = job?.state ?? 'empty';

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.dataset.state = state_;
  tile.dataset.angle = angle.id;
  tile.setAttribute('aria-label', `${angle.label}: ${angle.hint}`);

  const badge = { uploading: 'Uploading', failed: 'Failed', done: '✓' }[state_];
  tile.innerHTML = `
    ${job?.previewUrl ? `<img src="${escapeHtml(job.previewUrl)}" alt="" />` : '<span class="tile-plus">+</span>'}
    ${badge ? `<span class="tile-badge" data-kind="${state_}">${badge}</span>` : ''}
    <span class="tile-label">${escapeHtml(angle.label)}</span>
  `;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  // Opens the rear camera directly on a phone instead of the photo library.
  input.capture = 'environment';
  input.hidden = true;
  input.dataset.angle = angle.id;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file !== undefined) queue.add(angle.id, file);
    input.value = '';
  });

  tile.addEventListener('click', () => input.click());
  const wrapper = document.createElement('div');
  wrapper.append(tile, input);
  return wrapper;
}

function renderDetails() {
  const d = state.draft;
  el.title.textContent = 'The car';
  el.step.textContent = 'Step 2 of 4';
  el.footer.hidden = false;
  el.back.hidden = false;
  el.next.textContent = 'Next: money';
  el.next.disabled = false;

  el.screen.innerHTML = `
    <h2>Details</h2>
    <p class="hint">Buyers are bidding sight-unseen. What you put here is what they rely on.</p>

    <label>VIN
      <input id="f-vin" value="${escapeHtml(d.vin)}" maxlength="17" autocapitalize="characters"
             autocomplete="off" spellcheck="false" inputmode="text" />
      <span class="field-note" id="vin-note"></span>
    </label>

    <div class="row">
      <label>Year<input id="f-year" value="${escapeHtml(d.year)}" inputmode="numeric" /></label>
      <label>Make<input id="f-make" value="${escapeHtml(d.make)}" /></label>
    </div>
    <div class="row">
      <label>Model<input id="f-model" value="${escapeHtml(d.model)}" /></label>
      <label>Trim<input id="f-trim" value="${escapeHtml(d.trim)}" /></label>
    </div>
    <div class="row">
      <label>Odometer<input id="f-odo" value="${escapeHtml(d.odometerMiles)}" inputmode="numeric" /></label>
      <label>Keys<input id="f-keys" value="${escapeHtml(d.keyCount)}" inputmode="numeric" /></label>
    </div>

    <label>Title
      <select id="f-title">
        ${['clean', 'branded', 'salvage', 'unknown']
          .map(
            (v) =>
              `<option value="${v}"${d.titleStatus === v ? ' selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`,
          )
          .join('')}
      </select>
    </label>

    <h3 style="font-size:15px;margin:18px 0 8px">Anything to disclose?</h3>
    <p class="hint">Say it now. A buyer who finds it in the first 24 hours can hand the car back.</p>
    <div class="chips" id="chips">
      ${DISCLOSURES.map(
        (x) =>
          `<button class="chip" type="button" data-id="${x.id}" aria-pressed="${d.disclosures[x.id] ? 'true' : 'false'}">${escapeHtml(x.label)}</button>`,
      ).join('')}
    </div>
  `;

  const bind = (id, key, transform = (v) => v) => {
    document.getElementById(id).addEventListener('input', (event) => {
      state.draft[key] = transform(event.target.value);
      saveDraft();
    });
  };

  bind('f-vin', 'vin', (v) => v.toUpperCase());
  bind('f-year', 'year');
  bind('f-make', 'make');
  bind('f-model', 'model');
  bind('f-trim', 'trim');
  bind('f-odo', 'odometerMiles');
  bind('f-keys', 'keyCount');
  document.getElementById('f-title').addEventListener('change', (event) => {
    state.draft.titleStatus = event.target.value;
    saveDraft();
  });

  const vinInput = document.getElementById('f-vin');
  const vinNote = document.getElementById('vin-note');
  const paintVin = () => {
    const feedback = vinFeedback(vinInput.value);
    vinNote.textContent = feedback?.message ?? '';
    if (feedback) vinNote.dataset.tone = feedback.tone;
  };
  vinInput.addEventListener('input', paintVin);
  paintVin();

  document.getElementById('chips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (chip === null) return;
    const on = chip.getAttribute('aria-pressed') === 'true';
    chip.setAttribute('aria-pressed', on ? 'false' : 'true');
    state.draft.disclosures[chip.dataset.id] = !on;
    saveDraft();
  });
}

function renderMoney() {
  const d = state.draft;
  el.title.textContent = 'Money';
  el.step.textContent = 'Step 3 of 4';
  el.footer.hidden = false;
  el.back.hidden = false;
  el.next.textContent = 'Next: review';
  el.next.disabled = false;

  el.screen.innerHTML = `
    <h2>What would you put in it?</h2>
    <p class="hint">This is your floor. It is never shown to buyers — they only see whether it has been met.</p>

    <label>Your number
      <input id="f-walk" value="${escapeHtml(d.walkPrice)}" inputmode="decimal" placeholder="9,000" />
    </label>
    <label>Opening bid
      <input id="f-start" value="${escapeHtml(d.startingBid)}" inputmode="decimal" placeholder="8,000" />
      <span class="field-note" data-tone="warn">Start below your number. It is what gets the first hand up.</span>
    </label>

    <div class="card" id="quote"></div>
  `;

  const walk = document.getElementById('f-walk');
  const start = document.getElementById('f-start');

  const paintQuote = () => {
    const walkCents = dollarsToCents(walk.value);
    const quoteAt = walkCents ?? dollarsToCents(start.value);
    const card = document.getElementById('quote');

    if (quoteAt === null) {
      card.innerHTML =
        '<h3>Your fees</h3><p class="hint" style="margin:0">Enter a number to see exactly what you net.</p>';
      return;
    }

    card.innerHTML = `
      <h3>If it sells at ${escapeHtml(money(quoteAt))}</h3>
      <dl>
        <div class="kv"><dt>Sale price</dt><dd>${escapeHtml(money(quoteAt))}</dd></div>
        <div class="kv"><dt>AutoBank seller fee</dt><dd>−${escapeHtml(money(SELLER_FEE))}</dd></div>
        <div class="kv kv-total"><dt>You net</dt><dd>${escapeHtml(money(quoteAt - SELLER_FEE))}</dd></div>
      </dl>
      <p class="hint" style="margin:10px 0 0">The buyer pays a flat ${escapeHtml(money(buyerFeeFor(quoteAt)))} on top. Both fees are fixed — no percentage, no surprises.</p>
    `;
  };

  for (const [input, key] of [
    [walk, 'walkPrice'],
    [start, 'startingBid'],
  ]) {
    input.addEventListener('input', (event) => {
      state.draft[key] = event.target.value;
      saveDraft();
      paintQuote();
    });
  }
  paintQuote();
}

function renderReview() {
  const d = state.draft;
  state.problems = findProblems();
  const ready = state.problems.length === 0;
  const pending = queue.pendingCount();

  el.title.textContent = 'Review';
  el.step.textContent = 'Step 4 of 4';
  el.footer.hidden = false;
  el.back.hidden = false;
  el.next.textContent = pending > 0 ? `Uploading ${pending}…` : 'Start the 15-minute clock';
  el.next.disabled = !ready || pending > 0;

  const disclosed = DISCLOSURES.filter((x) => d.disclosures[x.id]);
  const starting = dollarsToCents(d.startingBid);
  const walk = dollarsToCents(d.walkPrice);

  el.screen.innerHTML = `
    ${
      ready
        ? ''
        : `<ul class="problems">${state.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
    }
    <div class="card">
      <h3>${escapeHtml([d.year, d.make, d.model, d.trim].filter(Boolean).join(' ') || 'The car')}</h3>
      <dl>
        <div class="kv"><dt>VIN</dt><dd>${escapeHtml(d.vin || '—')}</dd></div>
        <div class="kv"><dt>Odometer</dt><dd>${escapeHtml(Number(d.odometerMiles || 0).toLocaleString('en-US'))} mi</dd></div>
        <div class="kv"><dt>Title</dt><dd>${escapeHtml(d.titleStatus)}</dd></div>
        <div class="kv"><dt>Keys</dt><dd>${escapeHtml(d.keyCount || '—')}</dd></div>
        <div class="kv"><dt>Photos</dt><dd>${queue.uploaded().length} uploaded</dd></div>
      </dl>
    </div>
    <div class="card">
      <h3>Disclosed</h3>
      ${disclosed.length === 0 ? '<p class="hint" style="margin:0">Nothing disclosed.</p>' : `<dl>${disclosed.map((x) => `<div class="kv"><dt>${escapeHtml(x.label)}</dt><dd>yes</dd></div>`).join('')}</dl>`}
    </div>
    <div class="card">
      <h3>Money</h3>
      <dl>
        <div class="kv"><dt>Opening bid</dt><dd>${starting === null ? '—' : escapeHtml(money(starting))}</dd></div>
        <div class="kv"><dt>Your floor</dt><dd>${walk === null ? 'none' : escapeHtml(money(walk))}</dd></div>
      </dl>
      <p class="hint" style="margin:10px 0 0">Bidding opens in 15 minutes and runs 15. A late bid can stretch it by up to 5 more.</p>
    </div>
  `;
}

// --------------------------------------------------------------- live lane

function renderLive() {
  const live = state.live;
  el.footer.hidden = true;
  el.title.textContent = 'In the lane';
  el.step.textContent = '';

  el.screen.dataset.listingId = live.id;
  el.screen.innerHTML = `
    <div class="clock">
      <div class="clock-time" id="clock">--:--</div>
      <div class="clock-label" id="clock-label">starting soon</div>
    </div>
    <div class="price">
      <div class="price-amount" id="price">${escapeHtml(money(live.currentPrice))}</div>
      <div class="price-label" id="price-label">${live.bidCount === 0 ? 'no bids yet' : `${live.bidCount} bid${live.bidCount === 1 ? '' : 's'}`}</div>
      <div id="reserve"></div>
    </div>
    <div class="card">
      <h3>Bids</h3>
      <ul class="feed" id="feed"></ul>
    </div>
    <button class="btn btn-ghost btn-wide" id="another" type="button">Post another trade</button>
    <p class="hint" style="text-align:center;margin:14px 0 0">Lane ${escapeHtml(live.id.slice(-6).toUpperCase())}</p>
  `;

  document.getElementById('another').addEventListener('click', () => {
    closeFeed();
    clearDraft();
    go('photos');
  });

  paintReserve();
  paintFeed();
  startClock();
}

function paintReserve() {
  const node = document.getElementById('reserve');
  if (node === null) return;
  const { reserveState } = state.live;
  if (reserveState === 'no_reserve') return void (node.innerHTML = '');
  node.innerHTML =
    reserveState === 'met'
      ? '<span class="pill" data-tone="good">Your number is covered</span>'
      : '<span class="pill" data-tone="warn">Not yet at your number</span>';
}

function paintFeed() {
  const node = document.getElementById('feed');
  if (node === null) return;

  const bids = [...state.live.bids].reverse();
  node.innerHTML =
    bids.length === 0
      ? '<li class="feed-empty">Waiting for the first hand up.</li>'
      : bids
          .map(
            (bid) =>
              `<li><span>${escapeHtml(bid.dealerId)}</span><span class="feed-amount">${escapeHtml(money(bid.amount))}</span></li>`,
          )
          .join('');
}

let clockTimer = null;

function startClock() {
  clearInterval(clockTimer);
  clockTimer = setInterval(paintClock, 250);
  paintClock();
}

function paintClock() {
  const node = document.getElementById('clock');
  const label = document.getElementById('clock-label');
  if (node === null || state.live === null) return;

  const { status, opensAt, closesAt } = state.live;
  if (status === 'awarded' || status === 'no_sale') {
    clearInterval(clockTimer);
    node.textContent = status === 'awarded' ? 'Sold' : 'No sale';
    node.dataset.urgent = 'false';
    label.textContent =
      status === 'awarded'
        ? `to ${state.live.highBidderDealerId ?? 'the high bidder'}`
        : 'nobody met your number';
    return;
  }

  const target = status === 'live' ? closesAt : opensAt;
  if (target === null) return;

  // Server time, not the handset's — a phone two minutes fast would otherwise
  // show the lane closing two minutes early.
  const remaining = Math.max(0, new Date(target).getTime() - serverNow().getTime());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);

  node.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
  node.dataset.urgent = status === 'live' && remaining < 60_000 ? 'true' : 'false';
  label.textContent = status === 'live' ? 'left in the lane' : 'until bidding opens';
}

let socket = null;

function openFeed(listingId) {
  closeFeed();
  const { url, protocols } = feedUrl(listingId);
  socket = new WebSocket(url, protocols);

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    applyEvent(message);
  });

  // A dropped socket during a fifteen-minute run is not something to shrug at:
  // reconnect and take a fresh snapshot rather than showing a frozen price.
  socket.addEventListener('close', () => {
    if (state.screen !== 'live' || state.live === null) return;
    if (state.live.status === 'awarded' || state.live.status === 'no_sale') return;
    setTimeout(() => {
      if (state.screen === 'live') openFeed(listingId);
    }, 1_500);
  });
}

function closeFeed() {
  clearInterval(clockTimer);
  socket?.close();
  socket = null;
}

function applyEvent(message) {
  if (state.live === null) return;

  switch (message.type) {
    case 'snapshot':
      state.live = fromListing(message.listing);
      renderLive();
      break;

    case 'listing.opened':
      state.live.status = 'live';
      state.live.closesAt = message.closesAt;
      paintClock();
      break;

    case 'bid.placed':
      state.live.currentPrice = message.amount;
      state.live.reserveState = message.reserveState;
      state.live.closesAt = message.closesAt;
      state.live.bidCount += 1;
      state.live.bids.push({ dealerId: message.dealerId, amount: message.amount });
      state.live.highBidderDealerId = message.dealerId;
      document.getElementById('price').textContent = money(message.amount);
      document.getElementById('price-label').textContent =
        `${state.live.bidCount} bid${state.live.bidCount === 1 ? '' : 's'}`;
      paintReserve();
      paintFeed();
      paintClock();
      if (message.extended) toast('Late bid — clock extended.');
      break;

    case 'listing.closed':
      state.live.status = message.outcome;
      state.live.highBidderDealerId = message.buyerDealerId;
      if (message.price !== null) state.live.currentPrice = message.price;
      paintClock();
      paintFeed();
      break;

    default:
      break;
  }
}

function fromListing(listing) {
  return {
    id: listing.id,
    status: listing.status,
    opensAt: listing.opensAt,
    closesAt: listing.closesAt,
    currentPrice: listing.currentPrice,
    reserveState: listing.reserveState,
    bidCount: listing.bidCount,
    highBidderDealerId: listing.highBidderDealerId,
    bids: listing.bids.map((bid) => ({ dealerId: bid.dealerId, amount: bid.amount })),
  };
}

// ------------------------------------------------------------------ posting

async function post() {
  const d = state.draft;
  el.next.disabled = true;
  el.next.textContent = 'Posting…';

  try {
    await queue.settled();
    if (queue.failedCount() > 0) {
      toast('Some photos did not upload. Go back and retry them.');
      return;
    }

    const photos = queue.uploaded().map((entry) => ({
      angle: entry.angle,
      url: entry.url,
      takenAt: new Date().toISOString(),
    }));

    const disclosures = DISCLOSURES.filter((x) => d.disclosures[x.id]).map((x) => ({
      code: x.id,
      note: `${x.label} disclosed by the selling dealer.`,
    }));

    const created = await api.listings.create({
      vehicle: {
        vin: d.vin.toUpperCase(),
        year: parseInteger(d.year),
        make: d.make.trim(),
        model: d.model.trim(),
        trim: d.trim.trim() === '' ? null : d.trim.trim(),
        odometerMiles: parseInteger(d.odometerMiles),
        titleStatus: d.titleStatus,
        keyCount: parseInteger(d.keyCount),
        photos,
        disclosures,
      },
      startingBidCents: dollarsToCents(d.startingBid),
      reserveCents: dollarsToCents(d.walkPrice),
    });

    const published = await api.listings.publish(created.id);

    state.listing = published;
    state.live = fromListing(published);
    clearDraft();
    go('live');
    openFeed(published.id);
  } catch (error) {
    toast(error instanceof ApiError ? error.message : 'Could not post the trade.');
    el.next.disabled = false;
    el.next.textContent = 'Start the 15-minute clock';
  }
}

// -------------------------------------------------------------- navigation

function go(screen) {
  state.screen = screen;
  render();
  globalThis.scrollTo?.(0, 0);
}

function render() {
  switch (state.screen) {
    case 'key':
      return renderKey();
    case 'photos':
      return renderPhotos();
    case 'details':
      return renderDetails();
    case 'money':
      return renderMoney();
    case 'review':
      return renderReview();
    case 'live':
      return renderLive();
    default:
      return renderPhotos();
  }
}

el.next.addEventListener('click', () => {
  if (state.screen === 'review') return void post();
  const index = SCREENS.indexOf(state.screen);
  if (index >= 0 && index < SCREENS.length - 1) go(SCREENS[index + 1]);
});

el.back.addEventListener('click', () => {
  const index = SCREENS.indexOf(state.screen);
  if (index > 0) go(SCREENS[index - 1]);
});

queue.onChange(() => {
  // Keep completed uploads in the draft so a locked phone does not cost the
  // manager a re-shoot.
  state.draft.photoUrls = Object.fromEntries(
    queue.uploaded().map((entry) => [entry.angle, entry.url]),
  );
  saveDraft();

  if (state.screen === 'photos' || state.screen === 'review') render();
});

// Re-adopt anything that was already uploaded before a refresh.
for (const [angle, url] of Object.entries(state.draft.photoUrls ?? {})) {
  queue.restore(angle, url);
}

render();

export { state, findProblems, dollarsToCents, parseInteger, buyerFeeFor };
