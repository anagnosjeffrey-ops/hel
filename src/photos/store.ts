import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { type ImageType, extensionFor, sniffImageType } from './sniff.js';
import { DomainError } from '../domain/errors.js';

/** A phone photo at full resolution. Larger than this is a mistake, not a unit. */
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

export interface StoredPhoto {
  readonly id: string;
  readonly url: string;
  readonly contentType: ImageType;
  readonly bytes: number;
}

export interface PhotoBytes {
  readonly data: Buffer;
  readonly contentType: ImageType;
}

export interface PhotoStore {
  put(data: Buffer, dealerId: string): Promise<StoredPhoto>;
  get(id: string): Promise<PhotoBytes | null>;
}

/**
 * Photo ids are 256 bits of randomness and the URL carries no authentication.
 *
 * The alternative — an authenticated image endpoint — cannot be used from an
 * `<img>` tag without cookies or signed URLs, and every dealer bidding in a lane
 * is entitled to see the photos anyway. An unguessable URL is the same bargain
 * every image CDN makes. It is worth revisiting if photos ever carry something a
 * competing dealer should not see.
 */
function newPhotoId(): string {
  return randomBytes(32).toString('base64url');
}

/** Reject anything that is not a plain photo id before it reaches the disk. */
const SAFE_ID = /^[A-Za-z0-9_-]{43,44}$/;

export class FilesystemPhotoStore implements PhotoStore {
  readonly #root: string;
  readonly #index = new Map<string, string>();

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async put(data: Buffer, dealerId: string): Promise<StoredPhoto> {
    if (data.length === 0) {
      throw new DomainError('INVALID_LISTING', 'The photo is empty.');
    }
    if (data.length > MAX_PHOTO_BYTES) {
      throw new DomainError('INVALID_LISTING', 'The photo is larger than 12MB.');
    }

    const contentType = sniffImageType(data);
    if (contentType === null) {
      throw new DomainError(
        'INVALID_LISTING',
        'That file is not a JPEG, PNG, WebP, or HEIC image.',
      );
    }

    const id = newPhotoId();
    // Shard by the first two characters: a busy month of lanes puts tens of
    // thousands of files under one root otherwise.
    const path = join(this.#root, dealerId, id.slice(0, 2), `${id}.${extensionFor(contentType)}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    this.#index.set(id, path);

    return { id, url: `/photos/${id}`, contentType, bytes: data.length };
  }

  async get(id: string): Promise<PhotoBytes | null> {
    if (!SAFE_ID.test(id)) return null;

    const path = this.#index.get(id);
    if (path === undefined) return null;

    try {
      const data = await readFile(path);
      const contentType = sniffImageType(data);
      // Sniff again on the way out: what is served is decided by the bytes on
      // disk at this moment, not by what was recorded at upload time.
      return contentType === null ? null : { data, contentType };
    } catch {
      return null;
    }
  }
}

/** Keeps photos in memory. For tests, and for a single-process demo. */
export class MemoryPhotoStore implements PhotoStore {
  readonly #rows = new Map<string, PhotoBytes>();

  async put(data: Buffer, _dealerId: string): Promise<StoredPhoto> {
    if (data.length === 0) {
      throw new DomainError('INVALID_LISTING', 'The photo is empty.');
    }
    if (data.length > MAX_PHOTO_BYTES) {
      throw new DomainError('INVALID_LISTING', 'The photo is larger than 12MB.');
    }

    const contentType = sniffImageType(data);
    if (contentType === null) {
      throw new DomainError(
        'INVALID_LISTING',
        'That file is not a JPEG, PNG, WebP, or HEIC image.',
      );
    }

    const id = newPhotoId();
    this.#rows.set(id, { data, contentType });
    return { id, url: `/photos/${id}`, contentType, bytes: data.length };
  }

  async get(id: string): Promise<PhotoBytes | null> {
    return this.#rows.get(id) ?? null;
  }
}
