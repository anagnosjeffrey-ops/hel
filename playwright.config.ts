import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const PORT = 4100;

/**
 * Use a Chromium that is already on the machine when one is present.
 *
 * CI images often ship a browser whose build number does not match the one this
 * Playwright release would fetch, and downloading a second copy per run is
 * wasted minutes. Falling back to undefined lets Playwright do its normal thing
 * on a developer laptop.
 */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;

export default defineConfig({
  testDir: './e2e',
  // The capture app is used one-handed on a phone; that is the shape it has to
  // work in, so it is the shape the tests run in.
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Pixel 7'],
    trace: 'retain-on-failure',
    launchOptions: { ...(executablePath === undefined ? {} : { executablePath }) },
  },
  projects: [{ name: 'phone' }],
  reporter: process.env['CI'] === 'true' ? 'dot' : 'list',
  timeout: 30_000,
  webServer: {
    // Build first: the tests drive the app as it is actually shipped.
    command: 'npm run build && node dist/testing/e2e-server.js',
    port: PORT,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
