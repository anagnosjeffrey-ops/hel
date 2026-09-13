# Slot Caller

Real-time spoken narration of slot machine play, built for blind and
low-vision players.

Point your phone at the machine and play. Each time the reels stop, Slot
Caller tells you what happened — whether you won, how much, and what your
balance is now — and can read out the symbols showing on the reels.

It runs in the browser on an Android phone. Nothing to install from an app
store, and it works offline after the first run.

---

## What it does

- **Calls every spin.** A chime and then a sentence: "Win. 40 credits. 8 times
  your bet. Balance 535 credits."
- **Tracks your session.** Ask at any time and it says how many spins you have
  played, how much you have wagered and won, and whether you are up or down.
- **Reads the board.** Says the symbols on the reels, row by row. (Needs an
  API key — see below. Everything else works without one.)
- **Guides your aim by sound.** A tone pans toward the machine and pulses
  faster as it comes into frame, then chimes when it is lined up. You never
  need sighted help to point the camera.
- **Warns you when it loses sight of the machine,** so you are never left
  thinking silence means "no win".
- **Tells you when you hit a limit** you set — down so much, up so much, or
  played for so long.
- **Practice mode** runs a simulated machine so you can learn the sounds at
  home before you play for real.

## What it cannot do

Being straight with you about this, because a narration app that overstates
what it sees is worse than none:

- It reads the machine's **own printed meters** (CREDIT, BET, WIN). If a
  machine labels its meters in some way the app does not recognise, it will
  say "I could not read the result" rather than guess.
- It cannot see **inside** the machine. It knows only what is on the glass.
- **Symbol reading needs a network connection** and an API key. Number
  reading, win and loss calling, and session tracking all work offline.
- On machines whose win meter **counts up** over several seconds, the first
  announcement may be short. The app re-checks after about two and a half
  seconds and corrects itself out loud if the total changed.

---

## Setting it up on your Android phone

You only do this once.

### Step 1 — Put it on the web

The app needs to be served over https for the camera to work. GitHub Pages
does this for free. Turning Pages on for the first time needs one click from
the repository owner — GitHub does not let an automated workflow do it.

1. Open this link, which goes straight to the right settings page rather than
   making you navigate a menu tree:

   <https://github.com/anagnosjeffrey-ops/hel/settings/pages>

2. Find the **Source** combo box, under the "Build and deployment" heading,
   and choose **GitHub Actions**.

That is the whole setup. Everything after it is automatic. Within a couple of
minutes the app is live at:

`https://anagnosjeffrey-ops.github.io/hel/`

The workflow runs the test suite first and publishes only if it passes, and
it redeploys on every push, so the live URL stays current.

### Step 2 — Open it and allow the camera

1. Open **Chrome** on your Android phone and go to that address.
2. Swipe to the **Start narrating** button and double-tap it.
3. Chrome asks for camera permission. Choose **While using the app**.

### Step 3 — Add it to your home screen

So it opens like a normal app, full screen, with no address bar:

1. With the page open in Chrome, find Chrome's **menu** button (top right).
2. Choose **Add to Home screen**, then **Install**.
3. "Slot Caller" is now on your home screen with your other apps.

### Step 4 — Learn the sounds first, in practice mode

Do this at home, before a casino.

1. Open Slot Caller and press **Start practice mode**.
2. Press **Spin the practice machine** (or the space bar on a Bluetooth
   keyboard) a dozen times.
3. Listen for: a rising chime for a win — more notes for a bigger win — and a
   short low blip for no win. Press **Read the board** to hear the symbols.

Once you know what the sounds mean, you will not need the spoken sentence to
know whether you won. That is the point: it is faster than words.

---

## Using it at a machine

1. Sit down and press **Start narrating**.
2. Press **Aim the camera**. Turn the phone slowly toward the machine screen.
   The guide tone moves toward the side the machine is on, rises in pitch when
   you should tilt up, and pulses faster as you get closer. When it chimes, it
   is lined up.
3. **Prop the phone up** facing the screen — a phone stand, or leaned against
   your drink, works. It does not need to be held.
4. Play normally. Every spin is called.

Anytime:

| Button | Shortcut | What it does |
|---|---|---|
| Read the board | B | Says the symbols showing right now |
| How am I doing | H | Your running totals |
| Repeat that | R | Says the last announcement again |
| Aim the camera | A | Restarts the aiming tone |
| Stop talking | Q | Silences the current announcement |
| Start / stop | S | Turns narration on or off |

Shortcuts work with a Bluetooth keyboard. All controls are ordinary buttons,
so TalkBack swipe-and-double-tap works throughout.

### If it goes quiet

If the app says "I've lost sight of the machine", the phone has been knocked
or someone stepped in front of it. Press **Aim the camera** and line it up
again. It will never sit silent and let you think a losing spin happened when
it simply could not see.

---

## Reading the symbols (optional)

Reading the *numbers* is done on your phone, free and offline. Reading the
actual *symbols* on the reels needs a vision model, so it needs an Anthropic
API key.

1. Get a key at <https://console.anthropic.com/> — you add a small amount of
   credit and each board reading costs a fraction of a cent.
2. In Slot Caller, open **Settings**, then **Reading the symbols**, and paste
   the key in.
3. Press **Check the key** to confirm it works.

The key is stored only on your phone and is sent only to Anthropic. You can
set the app to read the board automatically on every win, on big wins only, or
never — under **What to announce**.

---

## A practical warning

Many casinos restrict photography and video on the gaming floor. Slot Caller
does not record or upload anything (unless you turn on symbol reading, which
sends a single still image to Anthropic), but staff cannot tell that by
looking. **Ask floor staff first.** Many properties will accommodate an
accessibility aid, and some are required to — but it is a much better
conversation to have before you start than after someone taps you on the
shoulder.

This works equally well on a home machine, an online slot on another screen,
or a tablet.

---

## For developers

No build step and no runtime dependencies. Plain ES modules.

```bash
npm test          # unit tests: parsing, spin logic, session maths, image analysis
npm run serve     # http://localhost:8080

npm run vendor    # download the OCR engine locally (once, ~27 MB)
npm run smoke     # end-to-end run in headless Chromium, offline once vendored
```

`npm run smoke` drives practice mode in a real browser and asserts that a spin
actually produces a spoken result, so it covers the wiring the unit tests
cannot: canvas frame → motion detection → OCR → meter parsing → spin engine →
narration. It also checks the accessibility basics — every control named and
labelled, no skipped heading levels, 44px minimum targets, no sideways
scrolling at phone width.

`npm run vendor` also lets you self-host the OCR engine instead of using a
CDN: serve `vendor/tesseract/` and set `window.TESSERACT_PATHS` (see
`src/ocr.js`).

### How it fits together

```
camera.js ──► frame.js ──► engine.js ──► session.js ──► speech.js
  frames      motion,       spin state    running        priority
              screen box    + outcome     totals         narration
                 │             ▲             │              ▲
                 ▼             │             ▼              │
              ocr.js ──► reading.js       audio.js ─────────┘
              Tesseract   meter values    earcons, haptics,
                          by label        aiming sonar
```

| File | Responsibility |
|---|---|
| `src/frame.js` | Motion score, screen detection, focus and exposure checks |
| `src/reading.js` | OCR words → credit / bet / win, plus the noise stabiliser |
| `src/engine.js` | Spin state machine and outcome arithmetic |
| `src/session.js` | Running totals, limits, and the spoken phrasing |
| `src/speech.js` | Priority speech queue with barge-in |
| `src/audio.js` | Earcons, haptics, aiming sonar |
| `src/camera.js` | getUserMedia, torch, frame capture, OCR pre-processing |
| `src/ocr.js` | Tesseract worker |
| `src/cloud.js` | Optional Claude vision calls |
| `src/simulator.js` | Practice machine (same interface as the camera) |
| `src/app.js` | Wiring, UI, settings |

The four modules that carry the logic worth being right about — `frame`,
`reading`, `engine`, `session` — are pure and have no DOM dependency, which is
why they can be tested properly.

## Licence

MIT.
