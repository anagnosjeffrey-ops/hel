# The currency-reading prompt

This is the exact prompt the app sends, pulled out so you can paste it into any
tool that accepts an image — the Claude console, a shortcut, a script, another
app entirely. It is kept in sync with `js/recognizer.js`; if you edit one,
edit the other.

The prompt is built to do one job well: look at a single frame of a banknote and
either name the denomination or admit it cannot. Everything about the wording is
aimed at making "unknown" a comfortable answer for the model to give, because a
confident wrong answer is the only outcome that actually costs the user money.

## System prompt

```text
You identify the denomination of United States paper currency for a blind
user who is counting a stack of bills by hand. You receive one camera frame
(sometimes two frames of the same bill) and return a single JSON verdict.

A wrong denomination costs this person real money and they cannot check your
work by looking. Reporting "unknown" is always better than a guess. Set
confidence to your genuine certainty, not to a polite high number.

What to read, in order of reliability:
1. The large numeral in the corners and the numeral over the portrait.
2. The word for the value spelled out along the bottom border.
3. The portrait: 1 Washington, 2 Jefferson, 5 Lincoln, 10 Hamilton,
   20 Jackson, 50 Grant, 100 Franklin.
4. The back vignette: 1 Great Seal, 2 signing of the Declaration,
   5 Lincoln Memorial, 10 Treasury Building, 20 White House,
   50 U.S. Capitol, 100 Independence Hall.
5. Colour, on 2004-and-later notes only: 5 purple-grey, 10 orange,
   20 green-peach, 50 pink-blue, 100 blue-teal with a 3-D ribbon.
   Colour alone is never sufficient — older notes are all grey-green.

Confirm the value from at least two independent cues before reporting
confidence above 0.9. If the only readable cue is colour, or a single
partly obscured numeral, confidence must stay below 0.7.

Expect the bill to be in motion, held in a hand, rotated, upside down, or
showing its back. None of that is a problem by itself and none of it should
lower your confidence — only illegibility should.

Report issue codes rather than guessing:
- "no_bill": no banknote in frame.
- "partial": part of a bill is cut off and the value cannot be confirmed.
- "blurry": motion blur or focus makes the value unreadable.
- "too_dark" / "glare": exposure prevents reading the value.
- "too_close": the bill fills the frame with no complete numeral visible.
- "too_far": the bill is too small in frame to read.
- "multiple_bills": more than one distinct banknote is visible.
- "not_us_currency": play money, movie prop money ("motion picture use
  only"), a coupon, a receipt, a gift card, or a note from another country.
- "none": the frame was readable.

Set bill_present true only for a real U.S. Federal Reserve Note. If two
frames are supplied they show the same bill; if they disagree, report the
lower confidence and prefer "unknown" over picking a side.

Transcribe the serial number only if you can read every character with
certainty; otherwise return an empty string. Never invent characters — the
app uses the serial to avoid counting one bill twice.
```

## User turn

One or two `image` content blocks (JPEG, base64), then the text:

```text
Identify this bill.
```

Two images should be two frames of the *same* bill — the prompt tells the model
to treat disagreement between them as a reason to lower confidence, which turns
a second frame into a genuine cross-check rather than a second guess.

## Response schema

Sent as `output_config.format`, so the reply is always parseable and every
field is guaranteed present:

```json
{
  "type": "object",
  "properties": {
    "bill_present": {
      "type": "boolean"
    },
    "bills_in_frame": {
      "type": "integer"
    },
    "denomination": {
      "type": "string",
      "enum": [
        "1",
        "2",
        "5",
        "10",
        "20",
        "50",
        "100",
        "unknown"
      ]
    },
    "confidence": {
      "type": "number"
    },
    "side": {
      "type": "string",
      "enum": [
        "front",
        "back",
        "unknown"
      ]
    },
    "serial": {
      "type": "string"
    },
    "issue": {
      "type": "string",
      "enum": [
        "none",
        "no_bill",
        "partial",
        "blurry",
        "too_dark",
        "glare",
        "too_close",
        "too_far",
        "multiple_bills",
        "not_us_currency"
      ]
    }
  },
  "required": [
    "bill_present",
    "bills_in_frame",
    "denomination",
    "confidence",
    "side",
    "serial",
    "issue"
  ],
  "additionalProperties": false
}
```

Denominations are strings rather than numbers, and `"unknown"` is a member of
the enum rather than a null, so there is exactly one shape to handle and no
chance of a null slipping through as a zero.

## A complete request

```bash
curl https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d @- <<JSON
{
  "model": "claude-opus-5",
  "max_tokens": 2000,
  "system": $(jq -Rs . < system-prompt.txt),
  "output_config": {
    "effort": "low",
    "format": { "type": "json_schema", "schema": $(jq -c . < schema.json) }
  },
  "messages": [{
    "role": "user",
    "content": [
      { "type": "image",
        "source": { "type": "base64", "media_type": "image/jpeg",
                    "data": "$(base64 -w0 bill.jpg)" } },
      { "type": "text", "text": "Identify this bill." }
    ]
  }]
}
JSON
```

`effort: "low"` is deliberate. This is perception, not deliberation — the model
either reads the numeral or it does not, and low effort keeps the round trip
short enough that a bill moving hand to hand still gets an answer before the
next one arrives.

## How to use the answer

Count the bill only when **all** of these hold:

- `bill_present` is true
- `bills_in_frame` is 1
- `denomination` is not `"unknown"`
- `issue` is `"none"`
- `confidence` is at or above your threshold (the app defaults to 0.85)

Anything else means say so out loud and count nothing. Do not fall back to a
best guess, do not average two uncertain readings into one confident one, and do
not let a retry quietly reuse the previous answer.

`serial` is the double-count guard: the same serial number twice in a row means
the same bill drifted back into view, not a second bill of the same value. The
prompt tells the model to return an empty string rather than guess at
characters, so an empty serial simply means "no guard available this time".
