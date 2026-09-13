import type { Page } from '@playwright/test';

export const SELLER_KEY = 'ab_e2e_seller_key';
export const BUYER_KEY = 'ab_e2e_buyer_key';
export const BUYER_C_KEY = 'ab_e2e_buyer_c_key';

/** A VIN with a valid ISO 3779 check digit. */
export const GOOD_VIN = '1HGCM82633A004352';

export const ANGLES = [
  'front_34',
  'rear_34',
  'driver_side',
  'passenger_side',
  'interior_front',
  'odometer',
  'engine_bay',
  'vin_plate',
] as const;

/** A real, minimal JPEG header — the server sniffs bytes, not filenames. */
export function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
}

/** Land on the photo screen with the key already accepted. */
export async function signIn(page: Page, key = SELLER_KEY): Promise<void> {
  await page.addInitScript((value) => {
    window.localStorage.setItem('autobank.apiKey', value);
  }, key);
  await page.goto('/app/');
}

export async function shoot(page: Page, angle: string): Promise<void> {
  await page.locator(`input[type=file][data-angle="${angle}"]`).setInputFiles({
    name: `${angle}.jpg`,
    mimeType: 'image/jpeg',
    buffer: jpegBytes(),
  });
}

export async function shootAllRequired(page: Page): Promise<void> {
  for (const angle of ANGLES) await shoot(page, angle);
  await page.getByText(`${ANGLES.length} of ${ANGLES.length}`).waitFor();
}

export async function fillDetails(page: Page, vin = GOOD_VIN): Promise<void> {
  await page.locator('#f-vin').fill(vin);
  await page.locator('#f-year').fill('2019');
  await page.locator('#f-make').fill('Toyota');
  await page.locator('#f-model').fill('Tacoma');
  await page.locator('#f-odo').fill('68412');
}

/** Place a bid as another dealer, the way dealer B's own app would. */
export async function bidAs(
  page: Page,
  listingId: string,
  amountCents: number,
  key = BUYER_KEY,
): Promise<number> {
  return page.evaluate(
    async ([id, amount, apiKey]) => {
      const response = await fetch(`/listings/${id}/bids`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ amountCents: amount }),
      });
      return response.status;
    },
    [listingId, amountCents, key] as const,
  );
}
