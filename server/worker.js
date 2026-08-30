/* Cloudflare Worker proxy — keeps your Anthropic API key off the phone.
 *
 * Deploy:
 *   npm i -g wrangler
 *   wrangler deploy server/worker.js --name bill-reader --compatibility-date 2026-01-01
 *   wrangler secret put ANTHROPIC_API_KEY
 *   wrangler secret put PROXY_TOKEN        # optional shared secret
 *
 * Then in the app: Settings -> Proxy, URL https://bill-reader.<you>.workers.dev/
 *
 * The worker builds the upstream request from scratch. The prompt, the schema,
 * the token ceiling and the model allowlist all live here; the only things a
 * caller gets to choose are which allowed model to use and which two JPEGs to
 * look at. So a leaked proxy URL is worth exactly one thing — identifying
 * banknotes — rather than being a general key to your account.
 */
import { SYSTEM, SCHEMA, ALLOWED_MODELS, LIMITS } from './prompt.mjs';

function cors(origin, env) {
  const allow = env.ALLOWED_ORIGIN || '*';
  return {
    'access-control-allow-origin': allow === '*' ? (origin || '*') : allow,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    'vary': 'Origin'
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

export default {
  async fetch(request, env) {
    const headers = cors(request.headers.get('origin'), env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, headers);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set' }, 500, headers);

    if (env.PROXY_TOKEN) {
      const auth = request.headers.get('authorization') || '';
      if (auth !== `Bearer ${env.PROXY_TOKEN}`) return json({ error: 'unauthorized' }, 401, headers);
    }

    let incoming;
    try {
      incoming = await request.json();
    } catch {
      return json({ error: 'invalid JSON' }, 400, headers);
    }

    // Take the images and nothing else. Any prompt, tool, or extra parameter
    // the caller sent is discarded here rather than forwarded upstream.
    const blocks = incoming?.messages?.[0]?.content;
    if (!Array.isArray(blocks)) return json({ error: 'no message content' }, 400, headers);

    const images = [];
    for (const b of blocks) {
      if (b?.type !== 'image' || b.source?.type !== 'base64') continue;
      if (images.length >= LIMITS.MAX_IMAGES) break;
      const data = String(b.source.data || '');
      if (data.length > LIMITS.MAX_IMAGE_BYTES) return json({ error: 'image too large' }, 413, headers);
      images.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
    }
    if (!images.length) return json({ error: 'no image supplied' }, 400, headers);

    const model = ALLOWED_MODELS.has(incoming.model) ? incoming.model : 'claude-opus-5';
    const body = {
      model,
      max_tokens: LIMITS.MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: [...images, { type: 'text', text: 'Identify this bill.' }] }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } }
    };

    const upstream = {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    };
    // Fast mode is Opus 5 only and costs more per token; opt in per request.
    if (incoming.speed === 'fast' && model === 'claude-opus-5') {
      body.speed = 'fast';
      upstream['anthropic-beta'] = 'fast-mode-2026-02-01';
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: upstream, body: JSON.stringify(body)
    });

    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': 'application/json', ...headers }
    });
  }
};
