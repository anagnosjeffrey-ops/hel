import { expect, test } from '@playwright/test';
import {
  ANGLES,
  GOOD_VIN,
  SELLER_KEY,
  fillDetails,
  shoot,
  shootAllRequired,
  signIn,
} from './helpers.js';

test.describe('signing in', () => {
  test('refuses a key the platform does not know', async ({ page }) => {
    await page.goto('/app/');
    await page.locator('#key-input').fill('ab_not-a-real-key');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.locator('#toast')).toContainText('not recognized');
    await expect(page.locator('#key-input')).toBeVisible();
  });

  test('accepts a real key and remembers it', async ({ page }) => {
    await page.goto('/app/');
    await page.locator('#key-input').fill(SELLER_KEY);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Eight shots' })).toBeVisible();

    // Reload: the manager should not sign in twice on the showroom floor.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Eight shots' })).toBeVisible();
  });
});

test.describe('photographing the car', () => {
  test('counts the required angles and unlocks the next step at eight', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('#bar-step')).toHaveText('0 of 8');
    await expect(page.getByRole('button', { name: 'Next: details' })).toBeDisabled();

    await shoot(page, 'front_34');
    await expect(page.locator('#bar-step')).toHaveText('1 of 8');
    await expect(page.getByRole('button', { name: 'Next: details' })).toBeDisabled();

    for (const angle of ANGLES.slice(1)) await shoot(page, angle);

    await expect(page.locator('#bar-step')).toHaveText('8 of 8');
    await expect(page.getByRole('button', { name: 'Next: details' })).toBeEnabled();
  });

  test('marks a tile done once its upload lands', async ({ page }) => {
    await signIn(page);
    await shoot(page, 'odometer');
    await expect(page.locator('.tile[data-angle="odometer"]')).toHaveAttribute(
      'data-state',
      'done',
    );
  });

  test('keeps uploaded photos across a reload', async ({ page }) => {
    await signIn(page);
    await shootAllRequired(page);

    await page.reload();
    await expect(page.locator('#bar-step')).toHaveText('8 of 8');
  });
});

test.describe('the VIN field', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await shootAllRequired(page);
    await page.getByRole('button', { name: 'Next: details' }).click();
  });

  test('confirms a VIN whose check digit matches', async ({ page }) => {
    await page.locator('#f-vin').fill(GOOD_VIN);
    await expect(page.locator('#vin-note')).toHaveText('VIN checks out.');
    await expect(page.locator('#vin-note')).toHaveAttribute('data-tone', 'good');
  });

  test('warns on a transposed character rather than blocking it', async ({ page }) => {
    await page.locator('#f-vin').fill('1HGCM82633A004325');
    await expect(page.locator('#vin-note')).toContainText('Check digit does not match');
    await expect(page.locator('#vin-note')).toHaveAttribute('data-tone', 'warn');
  });

  test('rejects letters a VIN never contains', async ({ page }) => {
    await page.locator('#f-vin').fill('1HGCM82633A00435O');
    await expect(page.locator('#vin-note')).toContainText('never contains I, O, or Q');
    await expect(page.locator('#vin-note')).toHaveAttribute('data-tone', 'bad');
  });

  test('counts down the remaining characters as it is typed', async ({ page }) => {
    await page.locator('#f-vin').fill('1HGCM8263');
    await expect(page.locator('#vin-note')).toHaveText('8 more characters');
  });
});

test.describe('the money screen', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await shootAllRequired(page);
    await page.getByRole('button', { name: 'Next: details' }).click();
    await fillDetails(page);
    await page.getByRole('button', { name: 'Next: money' }).click();
  });

  test('shows exactly what the dealer nets, before anything is posted', async ({ page }) => {
    await page.locator('#f-walk').fill('9000');

    await expect(page.locator('#quote')).toContainText('If it sells at $9,000');
    await expect(page.locator('#quote')).toContainText('$99');
    await expect(page.locator('#quote')).toContainText('$8,901');
  });

  test('states the buyer fee as a flat number too', async ({ page }) => {
    await page.locator('#f-walk').fill('12000');
    await expect(page.locator('#quote')).toContainText('flat $349');
    await expect(page.locator('#quote')).toContainText('no percentage');
  });
});

test.describe('review', () => {
  test('names what is still missing instead of just refusing', async ({ page }) => {
    await signIn(page);
    await shootAllRequired(page);
    await page.getByRole('button', { name: 'Next: details' }).click();
    // Deliberately leave the VIN and odometer empty.
    await page.locator('#f-make').fill('Toyota');
    await page.getByRole('button', { name: 'Next: money' }).click();
    await page.getByRole('button', { name: 'Next: review' }).click();

    const problems = page.locator('.problems');
    await expect(problems).toContainText('Enter a full 17-character VIN.');
    await expect(problems).toContainText('Enter the model.');
    await expect(problems).toContainText('Enter the odometer reading.');
    await expect(problems).toContainText('Enter the model year.');
    await expect(problems).toContainText('Set an opening bid.');
    await expect(page.getByRole('button', { name: 'Start the 15-minute clock' })).toBeDisabled();
  });

  test('requires a damage photo once damage is disclosed', async ({ page }) => {
    await signIn(page);
    await shootAllRequired(page);
    await page.getByRole('button', { name: 'Next: details' }).click();
    await fillDetails(page);
    await page.getByRole('button', { name: 'Frame damage' }).click();
    await page.getByRole('button', { name: 'Next: money' }).click();
    await page.locator('#f-start').fill('8000');
    await page.getByRole('button', { name: 'Next: review' }).click();

    await expect(page.locator('.problems')).toContainText('damage photo');

    // Shoot it, and the objection clears. Review -> money -> details -> photos.
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await shoot(page, 'damage');
    await page.getByRole('button', { name: 'Next: details' }).click();
    await page.getByRole('button', { name: 'Next: money' }).click();
    await page.getByRole('button', { name: 'Next: review' }).click();

    await expect(page.locator('.problems')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start the 15-minute clock' })).toBeEnabled();
  });
});
