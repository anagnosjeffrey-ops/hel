# AutoBank

A business-to-business auction lane for dealer trade-ins, run on a fifteen-minute
clock so a deal closes before the customer leaves the showroom.

**Up front, honest, and fair** — the motto is enforced in code, not just in
marketing. Fees are flat and published before the first bid. Required photo
angles and written disclosures are a precondition for opening a lane. Reserve
status is visible; the reserve number is not. Silence from a buyer past the
inspection deadline settles in the seller's favor.

## The transaction

A customer brings an off-brand trade into Gilroy, a domestic store. Gilroy would
have put $9,000 into it, because it has no retail channel for that model.

1. The used-car manager photographs the unit at the required angles and posts it.
2. The lane opens **fifteen minutes** later, giving buyers time to look.
3. The lane runs **fifteen minutes**. Dealers B through E — stores that do retail
   this model — bid it up.
4. It closes. Reserve met, so it awards. The gate pass QR exists at the hammer.
5. A carrier scans the QR at pickup and again at delivery.
6. The buying dealer has **24 hours** from delivery to inspect and finalize.
7. Gilroy gets paid.

Gilroy put $2,000 more into the customer's deal than it could have on its own,
and the customer never left the showroom. `src/showroom.test.ts` is that story,
executable.

## Revenue

| Source       | Structure                                                     |
| ------------ | ------------------------------------------------------------- |
| Subscription | Per rooftop, monthly: Starter $199, Dealer $499, Group $1,499 |
| Buyer fee    | Flat, tiered by sale price: $149 / $249 / $349 / $449         |
| Seller fee   | Flat $99                                                      |

Flat rather than percentage on purpose. A percentage moves while dealers are
bidding, so a seller cannot know its net until the hammer falls. Flat tiers let
both sides read their exact fee off the listing page before the first bid. All
figures live in `src/domain/fees.ts` and `src/domain/subscription.ts`.

## What is built

The domain core, storage, the live lane, and the app that posts a trade — 212
unit tests plus 20 browser tests. Every store test runs twice: once in memory,
once against a real Postgres.

| Module                   | Responsibility                                                     |
| ------------------------ | ------------------------------------------------------------------ |
| `domain/money.ts`        | Whole-cent integers. No floating point dollars, ever.              |
| `domain/increments.ts`   | Bid steps that scale with price ($50 → $500).                      |
| `domain/fees.ts`         | The published fee schedule and both sides of a quote.              |
| `domain/subscription.ts` | Plans, seats, and who is cleared to transact.                      |
| `domain/vehicle.ts`      | VIN validation, required photo set, disclosure rules.              |
| `domain/dealer.ts`       | Eligibility to buy and sell.                                       |
| `domain/listing.ts`      | The auction: scheduling, bidding, soft close, reserve.             |
| `domain/fulfillment.ts`  | Transport, the gate pass, inspection, arbitration, payout.         |
| `store/`                 | Aggregate storage behind one interface, in memory and in Postgres. |
| `realtime/`              | The event feed, in process and across instances.                   |
| `app/`                   | Commands, authorization, projections, and the scheduler.           |
| `http/`                  | The REST API, the websocket lane feed, and dealer authentication.  |

Every domain rule is a pure function over immutable state taking an explicit
`now`, so the fifteen-minute clock is testable without waiting fifteen minutes.

### Two dealers bidding in the same millisecond

This is the normal case in a fifteen-minute lane, not the edge case. `mutate`
is the only write path for an existing listing and it holds an exclusive lock
for the whole callback — `SELECT ... FOR UPDATE` in Postgres, a per-key queue in
memory. Read, validate, and append are one atomic step, so the second bidder
validates against the price the first one just set instead of a stale snapshot.

The contract test asserts it directly: fire two identical bids at once and
exactly one is accepted, the other comes back `BID_TOO_LOW`. Fire ten and the
stored prices are strictly rising with none lost.

### The live feed

A dealer's websocket is attached to whichever instance answered the upgrade, but
the bid that matters to them may land on any other. `PostgresEventBus` publishes
through `LISTEN/NOTIFY`, so every instance sees every bid in the database's
ordering — the same order the bids were validated in. The listening connection
is dedicated, outside the pool, and reconnects with backoff, because a dropped
listener fails silently: sockets stay open and simply stop updating.

Connecting to a lane sends a snapshot first, then the deltas, so a dealer who
joins thirty seconds before the close is immediately correct.

### The capture app

`/app/` — a phone-shaped web app, plain ES modules with no build step, driven in
Chromium by the Playwright suite at a Pixel 7 viewport because that is the shape
it actually gets used in.

The order of the screens is the order the work happens on a showroom floor:

1. **Eight shots.** A tile per required angle, each opening the rear camera
   directly. Uploads start the instant a photo is taken and run in the
   background, so they finish while the details are being typed — the showroom
   clock is the scarce resource, not bandwidth. Failed uploads retry with
   backoff and park themselves when the phone drops off wifi.
2. **Details.** The VIN check digit is validated as it is typed, warning rather
   than blocking, because an import may not carry one and refusing a real car is
   worse than the typo it catches. Disclosing frame damage, prior paint, a
   mechanical issue, or flood requires a damage photo before the trade can post.
3. **Money.** The question asked is "what would you put in it?", because that is
   the number the manager already has in their head. It becomes the hidden
   reserve. The exact fee and net are on screen before anything is committed.
4. **Review.** Everything still missing, named at once — not one objection per
   attempt while a customer waits.
5. **The lane.** A countdown, the live price, the reserve pill, and the bids
   arriving as they land.

Two details that matter more than they look:

- **The countdown runs on server time.** Every response carries a `Date` header,
  so the app tracks its offset from the server. A handset two minutes fast would
  otherwise show a lane closing two minutes early, in front of the customer.
- **The draft survives.** Fields go to `localStorage` as they are typed and
  uploaded photos are re-adopted by their server URLs, so a phone that locks
  mid-flow does not cost anyone a re-shoot.

### Photos

Uploads are identified by sniffing their magic bytes, never by the content type
the client declares. A file the platform serves back from its own origin as
`text/html` would run script against a logged-in dealer's session, so anything
that is not a real JPEG, PNG, WebP, or HEIC is refused at the door — an SVG
included, since it is a document that can carry script.

Photo URLs carry 256 bits of randomness and no authentication. An authenticated
image endpoint cannot be used from an `<img>` tag without cookies or signed
URLs, and every dealer in a lane is entitled to see the photos anyway. It is the
same bargain every image CDN makes, and worth revisiting if a photo ever carries
something a competing dealer should not see.

### The API

| Route                        |                                                            |
| ---------------------------- | ---------------------------------------------------------- |
| `POST /listings`             | Post a trade. Returns the seller's view, with the reserve. |
| `POST /listings/:id/publish` | Start the fifteen-minute countdown.                        |
| `GET /listings`              | Open lanes.                                                |
| `GET /listings/:id`          | Public view; the seller alone sees its reserve.            |
| `POST /listings/:id/bids`    | Bid. `409 BID_TOO_LOW` tells a client to re-bid.           |
| `POST /listings/:id/cancel`  | Seller only, and only before the lane opens.               |
| `GET /sales/:id`             | Buyer and seller only.                                     |
| `POST /sales/:id/accept`     | Buyer finalizes.                                           |
| `POST /sales/:id/dispute`    | Buyer arbitrates, inside the 24-hour window.               |
| `POST /transport/scan`       | The carrier's QR scan — pickup, then delivery.             |
| `WS /listings/:id/feed`      | One lane: snapshot, then every bid and the close.          |
| `WS /feed`                   | Every lane, for the buyer's lane list.                     |

Authentication is a per-rooftop API key, stored only as a SHA-256 digest and
presented as a bearer token. A browser websocket cannot set headers, so on that
one route the key travels as the `autobank.key.<key>` subprotocol — which keeps
it in a header rather than in a query string, where a long-lived credential would
land in every access log between here and the dealership. A short-lived connect
ticket would be better and is the intended next step. The transport scan is the exception: the gate pass
in the QR _is_ the credential, because whoever holds the paperwork is the one
moving the vehicle. That is a deliberate v1 tradeoff to revisit when carriers
have accounts.

Two things never cross the wire. The reserve is absent from the public view by
construction rather than filtered downstream, so one forgotten branch cannot
leak the seller's floor. The gate pass token is absent from every sale response,
because it is a bearer credential that moves a vehicle.

## What is not built yet

- **Identity beyond an API key.** No sessions, no rotation, no scopes, and no
  dealer-licence verification workflow — `--verified` just records that a human
  did it somewhere else.
- **Money movement.** `settle()` marks a sale paid; nothing moves funds. No
  subscription billing either, though the plans are priced.
- **Carrier network.** `assignCarrier()` takes an id. No dispatch, no
  marketplace, no carrier accounts.
- **Notifications.** Nothing pushes to a buyer when a lane opens.
- **The buyer's side.** Dealers B through E can bid over the API, but there is no
  screen for them to do it on — only the seller's capture app exists.
- **Image processing.** Photos are stored as shot: no resizing, no thumbnails,
  no EXIF stripping. A 12MB HEIC is served back at 12MB.
- **Offline posting.** Photos upload in the background and the draft survives a
  reload, but posting itself needs a live connection.
- **An append-only bid table.** Bids live in the listing aggregate, which is
  append-only in practice but is not the audit log a regulator would want.

## Decisions worth a second look

**Soft close.** A bid inside the final minute pushes the close out by a minute,
capped at five minutes total. Without it, snipers take trades under their worth,
which defeats the point. With an uncapped version, the seller cannot promise the
customer an end time. The cap makes worst case twenty minutes. Both numbers are
in `DEFAULT_AUCTION_RULES`.

**Seller discretion.** A lane that closes under reserve is a no-sale, but the
seller has ten minutes to take the high bid anyway. That window is a guess.

**Auto-accept on silence.** If a buyer says nothing for 24 hours after delivery,
the sale sticks. The alternative is a seller's money sitting behind someone
else's inbox.

**A dealer cannot outbid itself.** Standard lane practice, and it protects the
buyer from its own fat fingers.

**The reserve is asked for as "what would you put in it?"** Framing it as a
reserve invites a number the dealer invents; framing it as their own walk number
gets the one they were already going to act on.

**Money is strictly typed on the wire.** Ajv coercion is off, so `"800000"` is
rejected where `800000` is accepted. An integration sending money as a string
has a bug that is cheaper to find on its first request.

## Working on it

```bash
npm install
npm run db:setup   # starts Postgres, creates the role and both databases
npm test           # 212 tests, under two seconds
npm run test:e2e   # 20 browser tests against the real app
npm run check      # typecheck + lint + format + test
```

The suite needs a database: the store contract tests and the event-bus tests run
against a real Postgres, because an in-memory double that has never been checked
against the thing it stands in for is not evidence of anything. `db:setup` is
idempotent and runs automatically at the start of a Claude Code web session.

To run the server:

```bash
npm run build
cp .env.example .env
DATABASE_URL=postgres://autobank:autobank@127.0.0.1:5432/autobank \
  node dist/cli/register-dealer.js --id gilroy --name "Gilroy Motors" --verified
npm start
```

`register-dealer` prints the API key once and stores only its digest. There is
no way to recover it afterward, only to issue a new one.

The browser suite builds the project and runs it against an in-memory server
with the fifteen-minute clock compressed to seconds — everything else is what
ships. It uses a Chromium already on the machine when it finds one, rather than
downloading a second copy per run.

Node 22+. TypeScript, Fastify, `pg`; the capture app is plain ES modules with no
build step. Vitest, Playwright, ESLint, and Prettier for tooling.
