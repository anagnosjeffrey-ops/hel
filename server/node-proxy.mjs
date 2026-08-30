/* Same proxy as server/worker.js, for a plain Node host (a Raspberry Pi on your
 * own network, a small VPS, Render, Fly, anything that runs Node 18+).
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node server/node-proxy.mjs
 *
 * The app needs https to use the camera, so put this behind a TLS terminator
 * (Caddy, nginx, Cloudflare Tunnel) rather than exposing the port directly.
 */
import http from 'node:http';
import { SYSTEM, SCHEMA, ALLOWED_MODELS, LIMITS } from './prompt.mjs';

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_BODY = 8 * 1024 * 1024;

if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set.');
  process.exit(1);
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': ALLOWED_ORIGIN === '*' ? (origin || '*') : ALLOWED_ORIGIN,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'vary': 'Origin'
  };
}

function send(res, status, obj, origin) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders(origin) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, origin);
  if (PROXY_TOKEN && req.headers.authorization !== `Bearer ${PROXY_TOKEN}`) {
    return send(res, 401, { error: 'unauthorized' }, origin);
  }

  let incoming;
  try {
    incoming = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: 'invalid JSON' }, origin);
  }

  const blocks = incoming?.messages?.[0]?.content;
  if (!Array.isArray(blocks)) return send(res, 400, { error: 'no message content' }, origin);

  // Images only. The prompt and schema below are the server's, not the
  // caller's, so this endpoint cannot be repurposed.
  const images = [];
  for (const b of blocks) {
    if (b?.type !== 'image' || b.source?.type !== 'base64') continue;
    if (images.length >= LIMITS.MAX_IMAGES) break;
    const data = String(b.source.data || '');
    if (data.length > LIMITS.MAX_IMAGE_BYTES) return send(res, 413, { error: 'image too large' }, origin);
    images.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
  }
  if (!images.length) return send(res, 400, { error: 'no image supplied' }, origin);

  const model = ALLOWED_MODELS.has(incoming.model) ? incoming.model : 'claude-opus-5';
  const body = {
    model,
    max_tokens: LIMITS.MAX_TOKENS,
    system: SYSTEM,
    messages: [{ role: 'user', content: [...images, { type: 'text', text: 'Identify this bill.' }] }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } }
  };

  const headers = {
    'content-type': 'application/json',
    'x-api-key': API_KEY,
    'anthropic-version': '2023-06-01'
  };
  if (incoming.speed === 'fast' && model === 'claude-opus-5') {
    body.speed = 'fast';
    headers['anthropic-beta'] = 'fast-mode-2026-02-01';
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    send(res, upstream.status, await upstream.text(), origin);
  } catch (e) {
    send(res, 502, { error: 'upstream failed', detail: String(e && e.message) }, origin);
  }
});

server.listen(PORT, () => console.log(`bill-reader proxy listening on :${PORT}`));
