/**
 * cloud.js — optional Claude vision calls.
 *
 * Local OCR handles the numbers (credits, bet, win) and it does it offline,
 * free, and fast. What it cannot do is tell you that reel three landed on a
 * red seven. That needs a vision model, so this module is the "read me the
 * board" path — used on demand, not on every spin, because each call costs
 * money and takes a second or two.
 *
 * The player's API key is kept in localStorage on their own phone and sent
 * only to api.anthropic.com. Nothing is uploaded anywhere else, and the
 * whole module is inert until a key is entered.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export const MODELS = [
  { id: 'claude-sonnet-5', label: 'Balanced — fast and accurate (recommended)' },
  { id: 'claude-opus-5', label: 'Most accurate — slower, costs more' },
  { id: 'claude-haiku-4-5-20251001', label: 'Fastest and cheapest — less detail' },
];

const BOARD_PROMPT = `You are the eyes of a blind slot machine player. You are looking at a photo of a slot machine screen.

Describe what is on the reels right now, out loud, in the order a player would want to hear it. Be specific and brief - this is going to be read aloud by a screen reader, so no markdown, no lists, no preamble.

Say, in this order, and skip anything you genuinely cannot see:
1. The symbol grid, read row by row, left to right. Example: "Top row: cherry, bar, seven. Middle row: seven, seven, seven."
2. Any winning line the machine is highlighting, and what it pays.
3. Any bonus, free games, or feature banner on screen.
4. The credit, bet and win numbers if they are visible.

If the reels are still spinning or the picture is too blurry to read, say exactly that in one short sentence and nothing else. Keep the whole reply under 60 words.`;

const METER_PROMPT = `Look at this slot machine screen and report only its meters.

Reply with a single line of JSON and nothing else, in this exact shape:
{"credits": number or null, "bet": number or null, "win": number or null, "cash": true or false}

"cash" is true if the meters are shown in dollars rather than credits. Use null for anything you cannot read clearly. Do not guess.`;

export class VisionClient {
  constructor({ apiKey = '', model = MODELS[0].id } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.inFlight = false;
    this.lastError = null;
    this.calls = 0;
  }

  get configured() {
    return typeof this.apiKey === 'string' && this.apiKey.trim().length > 10;
  }

  async _call(prompt, imageBase64, { maxTokens = 300 } = {}) {
    if (!this.configured) throw new Error('No API key is set, so I can only read the numbers, not the symbols.');
    if (!imageBase64) throw new Error('There was no picture to send.');
    if (this.inFlight) throw new Error('Still working on the last look. One moment.');

    this.inFlight = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey.trim(),
          'anthropic-version': API_VERSION,
          // Required for calling the API straight from a browser page.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
                { type: 'text', text: prompt },
              ],
            },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(friendlyApiError(res.status, body));
      }
      const json = await res.json();
      this.calls += 1;
      const text = (json.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
      return text;
    } catch (err) {
      this.lastError = err;
      if (err.name === 'AbortError') throw new Error('That took too long. Try again.');
      throw err;
    } finally {
      clearTimeout(timeout);
      this.inFlight = false;
    }
  }

  /** Spoken description of the reels. */
  describeBoard(imageBase64) {
    return this._call(BOARD_PROMPT, imageBase64, { maxTokens: 300 });
  }

  /** Structured meter read, used when local OCR cannot find the numbers. */
  async readMeters(imageBase64) {
    const text = await this._call(METER_PROMPT, imageBase64, { maxTokens: 150 });
    return parseMeterJson(text);
  }
}

/** Pull the JSON object out of a model reply, tolerating stray prose. */
export function parseMeterJson(text) {
  if (!text) return null;
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      credits: num(obj.credits),
      bet: num(obj.bet),
      win: num(obj.win),
      cash: obj.cash === true,
    };
  } catch {
    return null;
  }
}

/** Turn HTTP failures into something worth speaking aloud. */
export function friendlyApiError(status, body = '') {
  if (status === 401) return 'That API key was not accepted. Check it and paste it again.';
  if (status === 403) return 'That API key does not have permission to use this model.';
  if (status === 429) return 'Too many requests just now. Wait a few seconds and try again.';
  if (status === 400 && /credit balance/i.test(body)) return 'That Anthropic account is out of credit.';
  if (status === 400) return 'The request was rejected. The picture may be unreadable.';
  if (status >= 500) return 'Anthropic had a server problem. Try again in a moment.';
  return `The board reading failed with error ${status}.`;
}
