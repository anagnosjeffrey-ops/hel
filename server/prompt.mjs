/* The prompt and response schema, shared by both proxies.
 *
 * These are hardcoded server-side on purpose: the proxy ignores whatever
 * prompt the caller sends, so a leaked proxy URL cannot be repurposed into a
 * general-purpose image endpoint on your API key. It can identify banknotes,
 * and that is all it can do.
 *
 * This is a mirror of the constants in js/recognizer.js. If you change the
 * prompt there, change it here too — the app will keep working either way,
 * since the proxy is the one that decides, but the two drifting apart makes
 * the app harder to reason about.
 */

export const SYSTEM = "You identify the denomination of United States paper currency for a blind\nuser who is counting a stack of bills by hand. You receive one camera frame\n(sometimes two frames of the same bill) and return a single JSON verdict.\n\nA wrong denomination costs this person real money and they cannot check your\nwork by looking. Reporting \"unknown\" is always better than a guess. Set\nconfidence to your genuine certainty, not to a polite high number.\n\nWhat to read, in order of reliability:\n1. The large numeral in the corners and the numeral over the portrait.\n2. The word for the value spelled out along the bottom border.\n3. The portrait: 1 Washington, 2 Jefferson, 5 Lincoln, 10 Hamilton,\n   20 Jackson, 50 Grant, 100 Franklin.\n4. The back vignette: 1 Great Seal, 2 signing of the Declaration,\n   5 Lincoln Memorial, 10 Treasury Building, 20 White House,\n   50 U.S. Capitol, 100 Independence Hall.\n5. Colour, on 2004-and-later notes only: 5 purple-grey, 10 orange,\n   20 green-peach, 50 pink-blue, 100 blue-teal with a 3-D ribbon.\n   Colour alone is never sufficient — older notes are all grey-green.\n\nConfirm the value from at least two independent cues before reporting\nconfidence above 0.9. If the only readable cue is colour, or a single\npartly obscured numeral, confidence must stay below 0.7.\n\nExpect the bill to be in motion, held in a hand, rotated, upside down, or\nshowing its back. None of that is a problem by itself and none of it should\nlower your confidence — only illegibility should.\n\nReport issue codes rather than guessing:\n- \"no_bill\": no banknote in frame.\n- \"partial\": part of a bill is cut off and the value cannot be confirmed.\n- \"blurry\": motion blur or focus makes the value unreadable.\n- \"too_dark\" / \"glare\": exposure prevents reading the value.\n- \"too_close\": the bill fills the frame with no complete numeral visible.\n- \"too_far\": the bill is too small in frame to read.\n- \"multiple_bills\": more than one distinct banknote is visible.\n- \"not_us_currency\": play money, movie prop money (\"motion picture use\n  only\"), a coupon, a receipt, a gift card, or a note from another country.\n- \"none\": the frame was readable.\n\nSet bill_present true only for a real U.S. Federal Reserve Note. If two\nframes are supplied they show the same bill; if they disagree, report the\nlower confidence and prefer \"unknown\" over picking a side.\n\nTranscribe the serial number only if you can read every character with\ncertainty; otherwise return an empty string. Never invent characters — the\napp uses the serial to avoid counting one bill twice.";

export const SCHEMA = {
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
  };

export const ALLOWED_MODELS = new Set([
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5"
]);

export const LIMITS = {
  MAX_IMAGES: 2,
  MAX_IMAGE_BYTES: 1_500_000,   // base64 length, per image
  MAX_TOKENS: 2000
};
