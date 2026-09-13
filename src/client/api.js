/**
 * The API client, plus the one thing a countdown on a phone cannot do without:
 * an estimate of how far the phone's clock is from the server's.
 *
 * A handset that is two minutes fast would show a lane closing two minutes
 * early. Every response carries a `Date` header, so the offset is free.
 */
let clockOffsetMs = 0;

export function serverNow() {
  return new Date(Date.now() + clockOffsetMs);
}

function recordClockOffset(response) {
  const header = response.headers.get('date');
  if (header === null) return;
  const serverTime = new Date(header).getTime();
  if (Number.isNaN(serverTime)) return;
  // Whole seconds only: the header has one-second resolution, so anything finer
  // is noise that would make the countdown jitter.
  clockOffsetMs = serverTime - Date.now();
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const KEY_STORAGE = 'autobank.apiKey';

export function getApiKey() {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setApiKey(key) {
  try {
    if (key === null) localStorage.removeItem(KEY_STORAGE);
    else localStorage.setItem(KEY_STORAGE, key);
  } catch {
    /* private browsing — the key simply will not persist */
  }
}

async function request(method, path, { body, formData } = {}) {
  const headers = {};
  const key = getApiKey();
  if (key !== null) headers.authorization = `Bearer ${key}`;

  let payload;
  if (formData !== undefined) {
    payload = formData;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const response = await fetch(path, { method, headers, body: payload });
  recordClockOffset(response);

  if (response.status === 204) return null;

  const text = await response.text();
  const parsed = text === '' ? null : safeJson(text);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      parsed?.code ?? 'HTTP_ERROR',
      parsed?.message ?? `Request failed (${response.status}).`,
    );
  }
  return parsed;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  listings: {
    create: (body) => request('POST', '/listings', { body }),
    publish: (id) => request('POST', `/listings/${id}/publish`),
    get: (id) => request('GET', `/listings/${id}`),
  },
  photos: {
    upload(file) {
      const form = new FormData();
      form.append('file', file, file.name || 'photo.jpg');
      return request('POST', '/photos', { formData: form });
    },
  },
  /** Verifies the key is real before the manager starts photographing a car. */
  verifyKey: () => request('GET', '/listings'),
};

export function feedUrl(listingId) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const key = getApiKey() ?? '';
  // A browser WebSocket cannot set headers, so the key rides the subprotocol —
  // the one header the API is allowed to shape. The server accepts either.
  return {
    url: `${scheme}//${location.host}/listings/${listingId}/feed`,
    protocols: [`autobank.key.${key}`],
  };
}
