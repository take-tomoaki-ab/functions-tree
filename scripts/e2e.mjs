// Playwright Chromium (open-source ビルド) に dist/ の拡張をロードし、
// 実際の GitHub PR ページで UI 注入と background 疎通を確認する。
//
// branded Chrome 137+ は --load-extension を無視するため channel: 'chromium' が必須。
//
// usage: node scripts/e2e.mjs [--repo owner/name] [--out screenshot-dir]

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const repo = argOf('--repo', 'microsoft/TypeScript');
const outDir = argOf('--out', 'e2e-results');
const distPath = fileURLToPath(new URL('../dist', import.meta.url));

mkdirSync(outDir, { recursive: true });
const userDataDir = mkdtempSync(join(tmpdir(), 'functions-tree-e2e-'));

const BUTTON = '#functions-tree-toggle';
const PANEL_STATUS = '#functions-tree-panel-host .status';

let failed = false;
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
};
const shot = async (page, name) => {
  const file = join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  screenshot: ${file}`);
};

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: [
    `--disable-extensions-except=${distPath}`,
    `--load-extension=${distPath}`,
  ],
});

try {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  // 1. リポジトリトップ: ボタンが出ないこと
  await page.goto(`https://github.com/${repo}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000); // content script のポーリング周期より長く待つ
  const buttonOnTop = await page.locator(BUTTON).count();
  record('repo top: no button injected', buttonOnTop === 0, `count=${buttonOnTop}`);
  await shot(page, '1-repo-top-no-button');

  // 2. PR 一覧からオープン PR を 1 つ選び、SPA 遷移で PR ページへ
  await page.goto(`https://github.com/${repo}/pulls`, { waitUntil: 'domcontentloaded' });
  const prLink = page.locator(`a[href*="/${repo}/pull/"]`).first();
  await prLink.waitFor({ timeout: 30_000 });
  const prHref = await prLink.getAttribute('href');
  console.log(`  navigating to PR: ${prHref}`);
  await prLink.click();
  await page.waitForURL(/\/pull\/\d+/, { timeout: 30_000 });

  // 3. PR ページ: ボタンが注入されること
  await page.locator(BUTTON).waitFor({ timeout: 15_000 });
  record('PR page: button injected', true, prHref);
  await shot(page, '2-pr-page-button');

  // 4. ボタン押下でパネルが開き、PING/PONG の結果が表示されること
  await page.locator(BUTTON).click();
  const status = page.locator(PANEL_STATUS);
  await status.waitFor({ timeout: 10_000 });
  await page.waitForFunction(
    (sel) => !document.querySelector('#functions-tree-panel-host')
      ?.shadowRoot?.querySelector('.status')?.textContent?.includes('確認中'),
    PANEL_STATUS,
    { timeout: 10_000 }
  );
  const statusText = (await status.textContent()) ?? '';
  record('panel: PING/PONG status shown', statusText.includes('疎通 OK'), statusText.trim());
  await shot(page, '3-panel-open-pingpong');

  // 5. 再度押下でパネルが閉じること
  await page.locator(BUTTON).click();
  const panelCount = await page.locator('#functions-tree-panel-host').count();
  record('panel: toggle closes panel', panelCount === 0, `count=${panelCount}`);

  // 6. SPA 遷移で PR ページを離れるとボタンが消えること（戻る = popstate）
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const buttonAfterLeave = await page.locator(BUTTON).count();
  record('SPA leave: button removed', buttonAfterLeave === 0, `count=${buttonAfterLeave}`);
  await shot(page, '4-spa-leave-no-button');

  // 7. SPA 遷移で PR ページに戻るとボタンが再注入されること
  await page.goForward({ waitUntil: 'domcontentloaded' });
  await page.locator(BUTTON).waitFor({ timeout: 15_000 });
  record('SPA re-enter: button re-injected', true);
  await shot(page, '5-spa-reenter-button');
} catch (e) {
  record('e2e run', false, e.message);
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log('\n== summary ==');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}: ${r.name}`);
process.exitCode = failed ? 1 : 0;
