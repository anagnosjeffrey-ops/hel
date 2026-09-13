import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sniffImageType } from './sniff.js';
import { FilesystemPhotoStore, MemoryPhotoStore, type PhotoStore } from './store.js';
import { DomainError } from '../domain/errors.js';

/** Minimal but genuine file headers. */
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'latin1'),
]);
const HEIC = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypheic', 'latin1'),
  Buffer.alloc(8),
]);

describe('image sniffing', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg'],
    ['PNG', PNG, 'image/png'],
    ['WebP', WEBP, 'image/webp'],
    ['HEIC from an iPhone', HEIC, 'image/heic'],
  ])('recognizes %s', (_label, bytes, expected) => {
    expect(sniffImageType(bytes)).toBe(expected);
  });

  /**
   * The attack this exists to stop: a file that would be served back from the
   * AutoBank origin as a page, with a logged-in dealer's session available to it.
   */
  it('refuses HTML no matter what it is called', () => {
    expect(sniffImageType(Buffer.from('<html><script>alert(1)</script>', 'utf8'))).toBeNull();
  });

  it('refuses an SVG, which is a document that can run script', () => {
    expect(
      sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">', 'utf8')),
    ).toBeNull();
  });

  it('refuses a truncated header that only starts like a PNG', () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it('refuses an empty buffer', () => {
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it('refuses a RIFF container that is not WebP', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVEfmt ', 'latin1'),
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });
});

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function filesystemStore(): Promise<PhotoStore> {
  const root = await mkdtemp(join(tmpdir(), 'autobank-photos-'));
  tempRoots.push(root);
  return new FilesystemPhotoStore(root);
}

const implementations: readonly [string, () => Promise<PhotoStore>][] = [
  ['memory', async () => new MemoryPhotoStore()],
  ['filesystem', filesystemStore],
];

describe.each(implementations)('%s photo store', (_name, makeStore) => {
  it('stores a photo and hands back an unguessable url', async () => {
    const store = await makeStore();
    const stored = await store.put(JPEG, 'gilroy');

    expect(stored.contentType).toBe('image/jpeg');
    expect(stored.bytes).toBe(JPEG.length);
    expect(stored.url).toBe(`/photos/${stored.id}`);
    // 256 bits of base64url.
    expect(stored.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('reads a photo back byte for byte', async () => {
    const store = await makeStore();
    const stored = await store.put(PNG, 'gilroy');
    const loaded = await store.get(stored.id);

    expect(loaded!.contentType).toBe('image/png');
    expect(loaded!.data.equals(PNG)).toBe(true);
  });

  it('gives two uploads of identical bytes separate ids', async () => {
    const store = await makeStore();
    const first = await store.put(JPEG, 'gilroy');
    const second = await store.put(JPEG, 'gilroy');
    expect(first.id).not.toBe(second.id);
  });

  it('returns null for an unknown id', async () => {
    const store = await makeStore();
    expect(await store.get('Ur42T5Jr5kMPYZ0ZRnTFwK0bW1bvJ8RbJZqVkzWgPZA')).toBeNull();
  });

  it('refuses a path traversal dressed up as an id', async () => {
    const store = await makeStore();
    expect(await store.get('../../../../etc/passwd')).toBeNull();
  });

  it('refuses a file that is not an image', async () => {
    const store = await makeStore();
    await expect(store.put(Buffer.from('<html>hi</html>', 'utf8'), 'gilroy')).rejects.toThrow(
      DomainError,
    );
  });

  it('refuses an empty upload', async () => {
    const store = await makeStore();
    await expect(store.put(Buffer.alloc(0), 'gilroy')).rejects.toThrow(/empty/);
  });

  it('refuses a photo over the size cap', async () => {
    const store = await makeStore();
    const huge = Buffer.concat([JPEG, Buffer.alloc(13 * 1024 * 1024)]);
    await expect(store.put(huge, 'gilroy')).rejects.toThrow(/larger than 12MB/);
  });
});
