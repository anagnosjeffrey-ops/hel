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

The domain core — the rules that decide money — with 84 tests behind it.

| Module                   | Responsibility                                             |
| ------------------------ | ---------------------------------------------------------- |
| `domain/money.ts`        | Whole-cent integers. No floating point dollars, ever.      |
| `domain/increments.ts`   | Bid steps that scale with price ($50 → $500).              |
| `domain/fees.ts`         | The published fee schedule and both sides of a quote.      |
| `domain/subscription.ts` | Plans, seats, and who is cleared to transact.              |
| `domain/vehicle.ts`      | VIN validation, required photo set, disclosure rules.      |
| `domain/dealer.ts`       | Eligibility to buy and sell.                               |
| `domain/listing.ts`      | The auction: scheduling, bidding, soft close, reserve.     |
| `domain/fulfillment.ts`  | Transport, the gate pass, inspection, arbitration, payout. |

Everything is a pure function over immutable state taking an explicit `now`, so
the fifteen-minute clock is testable without waiting fifteen minutes. `advance()`
and `advanceSale()` apply every transition the clock alone has earned — a worker
calls them on a tick, and every command calls them first so no caller can act on
a stale status.

## What is not built yet

- **Persistence.** No database. The domain is storage-agnostic on purpose.
- **API and realtime.** No HTTP server, no websocket bid feed.
- **Identity.** No dealer login, no licence verification workflow.
- **Money movement.** `settle()` marks a sale paid; nothing moves funds.
- **Carrier network.** `assignCarrier()` takes an id; no dispatch or marketplace.
- **Notifications.** No push to buyers when a lane opens.
- **The app the manager holds.** No photo capture UI.

## Decisions worth a second look

**Soft close.** A bid inside the final minute pushes the close out by a minute,
capped at five minutes total. Without it, snipers take trades under their worth,
which defeats the point. With an uncapped version, the seller cannot promise the
customer an end time. The cap makes worst case twenty minutes. Both numbers are
in `DEFAULT_AUCTION_RULES` — change them there.

**Seller discretion.** A lane that closes under reserve is a no-sale, but the
seller has ten minutes to take the high bid anyway. That window is a guess.

**Auto-accept on silence.** If a buyer says nothing for 24 hours after delivery,
the sale sticks. The alternative is a seller's money sitting behind someone
else's inbox.

**A dealer cannot outbid itself.** Standard lane practice, and it protects the
buyer from its own fat fingers.

## Working on it

```bash
npm install
npm test          # 84 tests, about a second
npm run check     # typecheck + lint + format + test
```

Node 22+. TypeScript, Vitest, ESLint, Prettier — nothing else in the dependency
tree.
