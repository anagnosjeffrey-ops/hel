import { expect, test, type Page } from '@playwright/test';
import { BUYER_C_KEY, BUYER_KEY, bidAs, fillDetails, shootAllRequired, signIn } from './helpers.js';

/**
 * The whole thing, in a browser, on a phone-sized screen: photograph a trade,
 * post it, and watch the lane run while dealers bid.
 *
 * The e2e server compresses the fifteen-minute clock to seconds. Everything
 * else — the API, the rules, the websocket — is exactly what ships.
 */
async function postTrade(page: Page, { walk = '9000', start = '8000' } = {}): Promise<string> {
  await signIn(page);
  await shootAllRequired(page);
  await page.getByRole('button', { name: 'Next: details' }).click();
  await fillDetails(page);
  await page.getByRole('button', { name: 'Next: money' }).click();
  await page.locator('#f-walk').fill(walk);
  await page.locator('#f-start').fill(start);
  await page.getByRole('button', { name: 'Next: review' }).click();
  await page.getByRole('button', { name: 'Start the 15-minute clock' }).click();

  await expect(page.locator('#clock-label')).toHaveText('until bidding opens');
  const listingId = await page.locator('#screen').getAttribute('data-listing-id');
  if (listingId === null) throw new Error('the live screen never carried a listing id');
  return listingId;
}

test.describe('a trade run end to end', () => {
  test('posts the trade and counts down to the open', async ({ page }) => {
    await postTrade(page);

    await expect(page.locator('#price')).toHaveText('$0');
    await expect(page.locator('#price-label')).toHaveText('no bids yet');
    await expect(page.locator('.feed-empty')).toContainText('Waiting for the first hand up');
    await expect(page.locator('#reserve')).toContainText('Not yet at your number');
  });

  test('opens the lane on its own when the clock runs out', async ({ page }) => {
    await postTrade(page);
    await expect(page.locator('#clock-label')).toHaveText('left in the lane', { timeout: 10_000 });
  });

  /**
   * The one that proves the live feed works from a browser. A browser websocket
   * cannot set an Authorization header, so the key travels as a subprotocol —
   * if that were wrong, this test would see a closed socket and no bid.
   */
  test('shows a bid from another dealer the moment it lands', async ({ page }) => {
    const listingId = await postTrade(page);
    await expect(page.locator('#clock-label')).toHaveText('left in the lane', { timeout: 10_000 });

    expect(await bidAs(page, listingId, 800_000, BUYER_KEY)).toBe(201);

    await expect(page.locator('#price')).toHaveText('$8,000');
    await expect(page.locator('#price-label')).toHaveText('1 bid');
    await expect(page.locator('.feed li').first()).toContainText('dealer-b');
    await expect(page.locator('.feed li').first()).toContainText('$8,000');
  });

  test("flips the reserve pill once bidding clears the dealer's number", async ({ page }) => {
    const listingId = await postTrade(page);
    await expect(page.locator('#clock-label')).toHaveText('left in the lane', { timeout: 10_000 });

    await bidAs(page, listingId, 800_000, BUYER_KEY);
    await expect(page.locator('#reserve')).toContainText('Not yet at your number');

    await bidAs(page, listingId, 950_000, BUYER_C_KEY);
    await expect(page.locator('#reserve')).toContainText('Your number is covered');
    await expect(page.locator('#price')).toHaveText('$9,500');
    await expect(page.locator('#price-label')).toHaveText('2 bids');
  });

  test('lands on sold when the lane closes over the reserve', async ({ page }) => {
    const listingId = await postTrade(page);
    await expect(page.locator('#clock-label')).toHaveText('left in the lane', { timeout: 10_000 });
    await bidAs(page, listingId, 1_100_000, BUYER_KEY);

    await expect(page.locator('#clock')).toHaveText('Sold', { timeout: 20_000 });
    await expect(page.locator('#clock-label')).toContainText('dealer-b');
    await expect(page.locator('#price')).toHaveText('$11,000');
  });

  test('says no sale when nobody reaches the number', async ({ page }) => {
    const listingId = await postTrade(page);
    await expect(page.locator('#clock-label')).toHaveText('left in the lane', { timeout: 10_000 });
    await bidAs(page, listingId, 800_000, BUYER_KEY);

    await expect(page.locator('#clock')).toHaveText('No sale', { timeout: 20_000 });
    await expect(page.locator('#clock-label')).toContainText('nobody met your number');
  });

  test('clears the draft so the next trade starts clean', async ({ page }) => {
    await postTrade(page);
    await page.getByRole('button', { name: 'Post another trade' }).click();

    await expect(page.getByRole('heading', { name: 'Eight shots' })).toBeVisible();
    await expect(page.locator('#bar-step')).toHaveText('0 of 8');
    await expect(page.getByRole('button', { name: 'Next: details' })).toBeDisabled();
  });
});
