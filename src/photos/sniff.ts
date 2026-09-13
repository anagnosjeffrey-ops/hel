/**
 * Identify an image from its bytes, never from the declared content type.
 *
 * A dealer uploads a file and the platform serves it back from its own origin.
 * If the stored type were the one the client claimed, an HTML file announced as
 * `image/jpeg` would come back as a page running script on the AutoBank origin,
 * with a logged-in dealer's session sitting right there. Sniffing the magic
 * bytes and refusing anything that is not an image closes that off at the door.
 */
export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';

function startsWith(data: Buffer, signature: readonly number[], offset = 0): boolean {
  if (data.length < offset + signature.length) return false;
  return signature.every((byte, index) => data[offset + index] === byte);
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const FTYP = [0x66, 0x74, 0x79, 0x70];

/** HEIC brands a modern iPhone writes. */
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'];

export function sniffImageType(data: Buffer): ImageType | null {
  if (startsWith(data, JPEG)) return 'image/jpeg';
  if (startsWith(data, PNG)) return 'image/png';
  // RIFF....WEBP — the four bytes between are the file size.
  if (startsWith(data, RIFF) && startsWith(data, WEBP, 8)) return 'image/webp';
  // ....ftyp<brand> — the first four bytes are the box size.
  if (startsWith(data, FTYP, 4)) {
    const brand = data.subarray(8, 12).toString('latin1');
    if (HEIC_BRANDS.includes(brand)) return 'image/heic';
  }
  return null;
}

export function extensionFor(type: ImageType): string {
  switch (type) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
      return 'heic';
  }
}
