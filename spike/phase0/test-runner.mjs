// Playwright Chromium で MV3 拡張を読み込み、result.html の JSON を回収する
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const extPath = fileURLToPath(new URL('./ext', import.meta.url));
const userDataDir = process.argv[2];
if (!userDataDir) {
  console.error('usage: node test-runner.mjs <fresh-user-data-dir>');
  process.exit(1);
}

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
  ],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) {
    console.error('[runner] waiting for service worker...');
    sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  }
  const extId = new URL(sw.url()).host;
  console.error('[runner] extension id:', extId);

  const page = await context.newPage();
  page.on('console', (m) => console.error('[page console]', m.text()));
  await page.goto(`chrome-extension://${extId}/result.html`);
  await page.waitForFunction(
    () => (document.getElementById('out')?.textContent ?? '').length > 2,
    { timeout: 60_000 }
  );
  const out = await page.locator('#out').textContent();
  console.log(out);
} catch (e) {
  console.error('[runner] FAILED:', e.message);
  // SW 内から直接状態を覗く（storage 内容と最後のエラー）
  const [sw] = context.serviceWorkers();
  if (sw) {
    const dump = await sw
      .evaluate(async () => {
        const stored = await chrome.storage.local.get(null);
        return JSON.stringify(stored);
      })
      .catch((err) => `sw evaluate failed: ${err.message}`);
    console.error('[runner] sw storage dump:', dump);
  }
  process.exitCode = 1;
} finally {
  await context.close();
}
