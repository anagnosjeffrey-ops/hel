/**
 * serve.js — dependency-free static server for local testing.
 *
 * Camera access needs a secure context, which means https or localhost.
 * localhost counts, so this is enough to exercise everything on a desktop;
 * to test on the phone over your network, use the deployed GitHub Pages URL.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (url.pathname === '/') file = path.join(root, 'index.html');

  // Never serve anything outside the project directory.
  if (!file.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(data);
  });
});

server.listen(port, () => {
  console.log(`Slot Caller running at http://localhost:${port}`);
});
