# Bill Reader

A camera app that speaks the denomination of each US bill you pass in front of
it and keeps a running total, so you can count a stack hand to hand without
stopping between bills.

It runs in the phone's browser, installs to the home screen, and does the actual
identification with Claude's vision model. There is no app store, no account,
and nothing to keep running — the whole thing is static files plus one API call
per bill.

---

## How you use it

1. Open the app and press **Start scanning** (the big button at the top of the
   controls; space bar also works).
2. It says *"Hold the camera clear for a moment"* — give it about a second with
   nothing in front of the lens. It is learning what an empty frame looks like.
3. It says *"Ready."* Now pass bills across the front of the phone, one at a
   time, moving from one hand to the other. Roughly 25–40 cm (10–16 inches) from
   the lens is the sweet spot.
4. Each bill gets a short rising chime and a spoken value: *"twenty."* Then a
   soft tick tells you it is armed for the next one.
5. Press **Speak total** any time, or just stop scanning — it announces the
   total automatically when you stop.

The rhythm matters more than precision. A bill needs about half a second in
frame, and the frame has to go empty between bills — that gap is how the app
knows the next bill is a *next* bill and not the same one still hanging around.
If you sweep too fast without a gap, it will simply not count the second one
rather than count the first one twice.

### The sounds

| Sound | Meaning |
|---|---|
| Soft high tick | Armed, ready for the next bill |
| Low click | Bill captured, asking the model |
| Two rising notes | Counted — the spoken value follows |
| Two falling notes | Not sure. Nothing counted. Show it again |
| Low buzz | Something failed (no connection, bad key). Nothing counted |
| Falling pair | Scanning stopped |

### Keyboard

`Space` start/stop · `T` speak total · `U` undo last bill · `L` list what you
have · `R` reset to zero · `Esc` close settings.

---

## Setting it up

The camera only works over `https`, so the app has to be hosted somewhere. Two
routes; the first takes about five minutes.

### Route 1 — GitHub Pages, key on the phone

1. Push this repository to GitHub.
2. Repository **Settings → Pages → Source: Deploy from a branch**, pick the
   branch and `/ (root)`, save. You get a URL like
   `https://yourname.github.io/hel/`.
3. Get an Anthropic API key from `console.anthropic.com`. **Set a monthly spend
   limit on it** — this is the key that will live on your phone.
4. Open the page on the phone, go to **Settings**, leave the mode on **Direct**,
   and paste the key. Add the page to your home screen.

The key is stored in that browser's local storage. Anyone who can unlock your
phone can retrieve it, so use a dedicated key with a low limit and revoke it if
the phone goes missing. That is the whole trade: no server to run, one secret in
a slightly awkward place.

### Route 2 — a proxy, key stays on a server

`server/worker.js` is a Cloudflare Worker; `server/node-proxy.mjs` is the same
thing for any Node 18+ host. Both build the upstream request from scratch: the
prompt, the schema, the token ceiling and the model allowlist all live in
`server/prompt.mjs` on the server, and anything the caller sends beyond "here
are one or two JPEGs, use this allowed model" is discarded. So a leaked proxy
URL is worth exactly one thing — identifying banknotes — rather than being a
general key to your account.

```bash
npm i -g wrangler
wrangler deploy server/worker.js --name bill-reader --compatibility-date 2026-01-01
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put PROXY_TOKEN          # optional, recommended
```

Then in **Settings** choose **Proxy**, enter
`https://bill-reader.<you>.workers.dev/` and the token. Nothing sensitive
touches the phone.

---

## Trying it without spending anything

Open the browser console on the page and rehearse the whole announcement path —
sounds, speech, totals, the duplicate-serial guard — with no camera and no API
call:

```js
BillReader.simulate({ bill_present: true, bills_in_frame: 1, denomination: '20',
  confidence: 0.96, side: 'front', serial: 'MB12345678A', issue: 'none' })

BillReader.simulate({ bill_present: true, bills_in_frame: 2, denomination: '10',
  confidence: 0.99, side: 'front', serial: '', issue: 'multiple_bills' })
```

`BillReader.metrics()` shows what the detector currently sees — occupancy,
motion, focus, brightness — which is the quickest way to tune the sensitivity
slider for your lighting.

There is also a test suite that drives the whole counting loop against a
scripted camera and canned model replies, so you can change the detector or the
thresholds and know immediately whether a bill can still be double-counted:

```bash
npm install
npm test
```

---

## What it costs

Each bill is one image plus a short prompt — roughly 1,700 input tokens and a
couple of hundred out.

| Model | Roughly per bill | Per 100 bills |
|---|---|---|
| Claude Opus 5 (default) | ~1.3¢ | ~$1.30 |
| Claude Sonnet 5 | ~0.5¢ | ~50¢ |
| Claude Haiku 4.5 | ~0.3¢ | ~25¢ |

Opus 5 is the default because it is the most accurate at reading a numeral off a
blurry, tilted, half-lit banknote, and accuracy is the entire point. If you are
counting large stacks routinely, Haiku 4.5 is a quarter of the price and still
good on a well-framed bill — switch in Settings and check it against a stack you
already know.

**Fast mode** (Settings) runs Opus 5 about 2.5× faster at premium pricing
(~2.6¢/bill). It is off by default. Turn it on if the pause between bills
bothers you more than the cost does.

---

## Please read this part

**This app can be wrong, and you cannot see that it is wrong.** That is an
uncomfortable thing to build, so here is exactly what it does about it:

- It never guesses. If the model is not confident, or the bill is blurry, or
  more than one bill is in frame, it says *"not sure"* and **counts nothing**.
  The confidence floor is 85% by default and adjustable.
- It reads the serial number when it can, and refuses to count the same serial
  twice in a row — the main defence against double-counting one bill.
- It will not silently substitute a lower or higher value. A miss is a miss.

What it still cannot do: catch a counterfeit, and catch a case where the model
reads a bill confidently and wrongly. For anything where being off by $90
matters — paying rent, handing over a deposit, counting a till — verify with a
second method.

Two worth knowing about:

- The **iBill Talking Banknote Identifier** is a free hardware reader from the
  US Bureau of Engraving and Printing for blind and visually impaired US
  residents. No phone, no network, no API bill. If you don't have one, it is
  worth the request form — this app is a good complement to it, not a
  replacement.
- **Seeing AI** (Microsoft, free) has a currency channel that identifies one
  bill at a time. Slower for a stack, useful as a cross-check.

Also: US bills are all the same size and there is no tactile marking, so folding
by denomination as you count — a common system, e.g. ones flat, fives folded
lengthwise, tens folded across, twenties folded twice — turns one good count
into a wallet you can read by touch afterwards. This app is much more useful as
the thing that sets that system up than as something you re-run at every till.

---

## Settings

**Recognition** — direct key or proxy; model; fast mode; the confidence floor;
and *confirm every bill with a second look*, which sends the two sharpest frames
of the same bill in one request and makes the model reconcile them. Slower,
noticeably steadier on worn or crumpled notes.

**Speech and sound** — voice, rate (up to 3×), whether to hear the running total
after every bill, sound cues, vibration, and framing help. Output can go through
the app's own voice, through your screen reader's live region, or both. If you
use VoiceOver or TalkBack, try **Screen reader** — it keeps everything in one
voice at one rate.

**Camera** — front or rear, torch on rear where supported, and detection
sensitivity. Raise sensitivity if bills are being missed; lower it if the app
fires at your hand or at someone walking past.

A note on the front camera: it is what you asked for and it is the default,
because passing a bill in front of the screen is a far more natural motion than
aiming a rear camera you cannot see through. But on most phones the front camera
is lower resolution and has fixed focus, so it is fussier about distance. If you
are getting a lot of *"too blurry"*, try holding bills a little farther out, or
switch to the rear camera for a difficult stack.

---

## How it works

```
camera frame ──▶ detector (on device, ~20 Hz)
                   │  is a bill in frame? is it sharp enough?
                   │  has the frame gone empty since the last one?
                   ▼
              sharpest frame ──▶ Claude (one request, strict JSON)
                                    │
                                    ▼
                            verdict ──▶ confidence + serial checks
                                            │
                                            ▼
                                   speak it, add to total
```

The detector is the reason this feels like counting rather than like scanning.
It keeps a slow background model of the empty frame, measures how much of the
centre differs from it, and uses the variance of the Laplacian as a focus score
to pick the moment your hand slowed down. Only then does it spend a network
round trip. Everything else — the priority queue that lets a denomination cut
off a running-total announcement, the clear-the-frame gate, the serial check —
exists to keep the spoken output in step with your hands.

| File | Does |
|---|---|
| `js/detector.js` | When to look: occupancy, motion, focus, background model |
| `js/camera.js` | Stream, capture, the small grayscale buffer |
| `js/recognizer.js` | The prompt, the JSON schema, the API call, retries |
| `js/app.js` | The state machine and all the wiring |
| `js/speech.js` | Speech priority queue, earcons, haptics |
| `js/tally.js` | The count, undo, breakdown, export |
| `prompts/` | The prompt on its own, for use outside this app |
| `server/prompt.mjs` | The prompt and schema the proxies enforce |
| `test/` | Counting-loop and proxy tests |
| `server/worker.js`, `server/node-proxy.mjs` | Proxies for keeping the key off the phone |

The prompt itself is in `prompts/currency-vision-prompt.md` — that is the other
half of what you asked for, and it works in anything that takes an image, not
just this app.

---

## Limitations

- Needs a network connection for every bill. Nothing is identified on-device.
- Coins are not handled at all.
- US Federal Reserve Notes only. Other currencies are reported as *not a US
  bill* rather than converted or guessed at.
- iOS Safari does not support vibration, so on iPhone the sound cues do the work
  the haptics would.
- Backgrounding the app stops scanning; the total is saved and restored.
