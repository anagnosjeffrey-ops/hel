import { api } from './api.js';

/**
 * Background photo uploads.
 *
 * Photographing the car and filling in the details are the two things the
 * manager does, and they happen in that order — so the uploads run during the
 * typing and are finished before anyone presses post. Dealership wifi drops, so
 * every upload retries with backoff and the queue parks itself when the phone
 * goes offline rather than burning through attempts.
 */
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 800;

export class UploadQueue {
  #jobs = new Map();
  #listeners = new Set();
  #draining = false;

  constructor() {
    // Coming back onto wifi should resume immediately, not on the next backoff.
    globalThis.addEventListener?.('online', () => void this.#drain());
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Every angle that has a photo, whatever its upload state. */
  entries() {
    return [...this.#jobs.entries()].map(([angle, job]) => ({
      angle,
      state: job.state,
      previewUrl: job.previewUrl,
      url: job.url,
      error: job.error,
    }));
  }

  get(angle) {
    const job = this.#jobs.get(angle);
    return job === undefined ? null : { ...job };
  }

  /** Angles whose photo is stored server-side and ready to post. */
  uploaded() {
    return this.entries().filter((entry) => entry.state === 'done');
  }

  pendingCount() {
    return this.entries().filter((entry) => entry.state === 'uploading' || entry.state === 'queued')
      .length;
  }

  failedCount() {
    return this.entries().filter((entry) => entry.state === 'failed').length;
  }

  /**
   * Replace whatever is held for this angle. Re-shooting a photo is common —
   * the first one is blurry, or the customer moved — so the newest wins and the
   * old preview is released.
   */
  add(angle, file) {
    const existing = this.#jobs.get(angle);
    if (existing?.previewUrl) URL.revokeObjectURL(existing.previewUrl);

    this.#jobs.set(angle, {
      file,
      state: 'queued',
      previewUrl: URL.createObjectURL(file),
      url: null,
      error: null,
      attempts: 0,
    });
    this.#emit();
    void this.#drain();
  }

  /**
   * Re-adopt a photo that was already uploaded — after a refresh, or a phone
   * that locked mid-flow. The bytes are on the server; only the page was lost.
   */
  restore(angle, url) {
    this.#jobs.set(angle, {
      file: null,
      state: 'done',
      previewUrl: url,
      url,
      error: null,
      attempts: 0,
    });
    this.#emit();
  }

  remove(angle) {
    const existing = this.#jobs.get(angle);
    if (existing?.previewUrl) URL.revokeObjectURL(existing.previewUrl);
    this.#jobs.delete(angle);
    this.#emit();
  }

  /** Put failed jobs back in line — the button a manager taps after a dropout. */
  retryFailed() {
    for (const job of this.#jobs.values()) {
      if (job.state === 'failed') {
        job.state = 'queued';
        job.attempts = 0;
        job.error = null;
      }
    }
    this.#emit();
    void this.#drain();
  }

  clear() {
    for (const job of this.#jobs.values()) {
      if (job.previewUrl) URL.revokeObjectURL(job.previewUrl);
    }
    this.#jobs.clear();
    this.#emit();
  }

  async settled() {
    while (this.pendingCount() > 0) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  async #drain() {
    if (this.#draining) return;
    this.#draining = true;

    try {
      for (;;) {
        const next = [...this.#jobs.entries()].find(([, job]) => job.state === 'queued');
        if (next === undefined) return;

        const [, job] = next;
        job.state = 'uploading';
        this.#emit();

        try {
          const stored = await api.photos.upload(job.file);
          job.url = stored.url;
          job.state = 'done';
          job.error = null;
        } catch (error) {
          job.attempts += 1;

          // A rejected photo will be rejected again however many times it is
          // sent; only a transport failure is worth retrying.
          const permanent = error.status !== undefined && error.status >= 400 && error.status < 500;
          if (permanent || job.attempts >= MAX_ATTEMPTS) {
            job.state = 'failed';
            job.error = error.message ?? 'Upload failed.';
          } else {
            job.state = 'queued';
            this.#emit();
            await this.#backoff(job.attempts);
            continue;
          }
        }
        this.#emit();
      }
    } finally {
      this.#draining = false;
    }
  }

  async #backoff(attempt) {
    const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
    // Offline: wait to be woken by the `online` listener instead of spinning.
    while (globalThis.navigator !== undefined && globalThis.navigator.onLine === false) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  #emit() {
    for (const listener of this.#listeners) listener(this.entries());
  }
}
