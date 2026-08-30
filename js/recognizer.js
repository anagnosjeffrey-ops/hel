/* Talks to Claude. One frame (or two, in confirm mode) goes out, one strict
 * JSON verdict comes back.
 *
 * The whole design leans on one rule: the model may say "I don't know", and the
 * app treats that as a perfectly good answer. Miscounting money silently is the
 * only truly bad outcome here, so nothing in this file encourages a guess.
 */
window.Recognizer = (function () {

  var SYSTEM = [
    'You identify the denomination of United States paper currency for a blind',
    'user who is counting a stack of bills by hand. You receive one camera frame',
    '(sometimes two frames of the same bill) and return a single JSON verdict.',
    '',
    'A wrong denomination costs this person real money and they cannot check your',
    'work by looking. Reporting "unknown" is always better than a guess. Set',
    'confidence to your genuine certainty, not to a polite high number.',
    '',
    'What to read, in order of reliability:',
    '1. The large numeral in the corners and the numeral over the portrait.',
    '2. The word for the value spelled out along the bottom border.',
    '3. The portrait: 1 Washington, 2 Jefferson, 5 Lincoln, 10 Hamilton,',
    '   20 Jackson, 50 Grant, 100 Franklin.',
    '4. The back vignette: 1 Great Seal, 2 signing of the Declaration,',
    '   5 Lincoln Memorial, 10 Treasury Building, 20 White House,',
    '   50 U.S. Capitol, 100 Independence Hall.',
    '5. Colour, on 2004-and-later notes only: 5 purple-grey, 10 orange,',
    '   20 green-peach, 50 pink-blue, 100 blue-teal with a 3-D ribbon.',
    '   Colour alone is never sufficient — older notes are all grey-green.',
    '',
    'Confirm the value from at least two independent cues before reporting',
    'confidence above 0.9. If the only readable cue is colour, or a single',
    'partly obscured numeral, confidence must stay below 0.7.',
    '',
    'Expect the bill to be in motion, held in a hand, rotated, upside down, or',
    'showing its back. None of that is a problem by itself and none of it should',
    'lower your confidence — only illegibility should.',
    '',
    'Report issue codes rather than guessing:',
    '- "no_bill": no banknote in frame.',
    '- "partial": part of a bill is cut off and the value cannot be confirmed.',
    '- "blurry": motion blur or focus makes the value unreadable.',
    '- "too_dark" / "glare": exposure prevents reading the value.',
    '- "too_close": the bill fills the frame with no complete numeral visible.',
    '- "too_far": the bill is too small in frame to read.',
    '- "multiple_bills": more than one distinct banknote is visible.',
    '- "not_us_currency": play money, movie prop money ("motion picture use',
    '  only"), a coupon, a receipt, a gift card, or a note from another country.',
    '- "none": the frame was readable.',
    '',
    'Set bill_present true only for a real U.S. Federal Reserve Note. If two',
    'frames are supplied they show the same bill; if they disagree, report the',
    'lower confidence and prefer "unknown" over picking a side.',
    '',
    'Transcribe the serial number only if you can read every character with',
    'certainty; otherwise return an empty string. Never invent characters — the',
    'app uses the serial to avoid counting one bill twice.'
  ].join('\n');

  var USER_TEXT = 'Identify this bill.';

  var SCHEMA = {
    type: 'object',
    properties: {
      bill_present: { type: 'boolean' },
      bills_in_frame: { type: 'integer' },
      denomination: { type: 'string', enum: ['1', '2', '5', '10', '20', '50', '100', 'unknown'] },
      confidence: { type: 'number' },
      side: { type: 'string', enum: ['front', 'back', 'unknown'] },
      serial: { type: 'string' },
      issue: {
        type: 'string',
        enum: ['none', 'no_bill', 'partial', 'blurry', 'too_dark', 'glare',
               'too_close', 'too_far', 'multiple_bills', 'not_us_currency']
      }
    },
    required: ['bill_present', 'bills_in_frame', 'denomination', 'confidence', 'side', 'serial', 'issue'],
    additionalProperties: false
  };

  function buildBody(images, settings) {
    var content = [];
    for (var i = 0; i < images.length; i++) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: images[i] }
      });
    }
    content.push({ type: 'text', text: USER_TEXT });

    var body = {
      model: settings.model,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: 'user', content: content }],
      // Low effort keeps latency down; this is perception, not deliberation.
      // The schema is what guarantees we can act on the answer safely.
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCHEMA }
      }
    };
    // Fast mode is Opus 5 only, and is billed at a premium rate.
    if (settings.fastMode && settings.model === 'claude-opus-5') body.speed = 'fast';
    return body;
  }

  function endpoint(settings) {
    if (settings.mode === 'proxy') {
      if (!settings.proxyUrl) throw new Error('NO_PROXY');
      return settings.proxyUrl;
    }
    if (!settings.apiKey) throw new Error('NO_KEY');
    return 'https://api.anthropic.com/v1/messages';
  }

  function headers(settings, body) {
    var h = { 'content-type': 'application/json' };
    if (settings.mode === 'proxy') {
      if (settings.proxyToken) h['authorization'] = 'Bearer ' + settings.proxyToken;
      return h;
    }
    h['x-api-key'] = settings.apiKey;
    h['anthropic-version'] = '2023-06-01';
    // Required for a browser to call the API directly; it also acknowledges
    // that the key is exposed to this page.
    h['anthropic-dangerous-direct-browser-access'] = 'true';
    if (body.speed === 'fast') h['anthropic-beta'] = 'fast-mode-2026-02-01';
    return h;
  }

  /* The response may be a plain Messages API payload (direct, or a transparent
     proxy) or an already-extracted verdict (a proxy that parses for us). */
  function extract(json) {
    if (json && typeof json.denomination === 'string') return json;
    if (json && json.parsed_output) return json.parsed_output;
    if (json && Array.isArray(json.content)) {
      for (var i = 0; i < json.content.length; i++) {
        var block = json.content[i];
        if (block.type === 'text' && block.text) {
          try { return JSON.parse(block.text); } catch (e) { /* keep looking */ }
        }
      }
    }
    throw new Error('BAD_RESPONSE');
  }

  function identify(images, settings, timeoutMs) {
    var body = buildBody(images, settings);
    var url, hdrs;
    try {
      url = endpoint(settings);
      hdrs = headers(settings, body);
    } catch (e) {
      return Promise.reject(e);
    }

    var attempt = 0;
    function run() {
      attempt++;
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 9000);

      return fetch(url, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify(body),
        signal: ctrl.signal,
        cache: 'no-store'
      }).then(function (res) {
        clearTimeout(timer);
        if (!res.ok) {
          return res.text().then(function (t) {
            var err = new Error(res.status === 401 || res.status === 403 ? 'AUTH'
                       : res.status === 429 ? 'RATE_LIMIT'
                       : res.status >= 500 ? 'SERVER' : 'HTTP_' + res.status);
            err.status = res.status;
            err.detail = t && t.slice(0, 400);
            throw err;
          });
        }
        return res.json();
      }).then(extract).catch(function (err) {
        clearTimeout(timer);
        var retryable = err.name === 'AbortError' ||
                        err.message === 'RATE_LIMIT' ||
                        err.message === 'SERVER' ||
                        err.message === 'Failed to fetch' ||
                        err instanceof TypeError;
        if (retryable && attempt < 2) {
          return new Promise(function (r) { setTimeout(r, 450); }).then(run);
        }
        if (err.name === 'AbortError') throw new Error('TIMEOUT');
        if (err instanceof TypeError) throw new Error('NETWORK');
        throw err;
      });
    }
    return run();
  }

  return { identify: identify, SYSTEM: SYSTEM, SCHEMA: SCHEMA };
})();
