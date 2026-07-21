// Playwright Chromium (open-source ビルド) に dist/ の拡張をロードし、
// 実際の GitHub PR ページで UI 注入と background 疎通を確認する。
//
// branded Chrome 137+ は --load-extension を無視するため channel: 'chromium' が必須。
//
// Phase 2 で追加した確認項目:
// - パネルを開くと変更ファイル一覧が表示される（未認証モード表示込み）
// - options ページで PAT の保存・削除が chrome.storage.local に反映される
// - エラー経路: 存在しない PR 番号 → not_found / 無効 PAT の接続テスト → 401 表示
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
const DUMMY_PAT = 'ghp_dummy_e2e_token_do_not_use_1234567890';

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

  // 4. ボタン押下でパネルが開き、変更ファイル一覧が表示されること（未認証モード）
  await page.locator(BUTTON).click();
  const status = page.locator(PANEL_STATUS);
  await status.waitFor({ timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const t = document.querySelector('#functions-tree-panel-host')
        ?.shadowRoot?.querySelector('.status')?.textContent ?? '';
      return t !== '' && !t.includes('取得中');
    },
    undefined,
    { timeout: 30_000 }
  );
  const statusText = ((await status.textContent()) ?? '').trim();
  const fileCount = await page.evaluate(() =>
    document.querySelector('#functions-tree-panel-host')
      ?.shadowRoot?.querySelectorAll('.file-item').length ?? 0
  );
  record(
    'panel: PR file list rendered',
    statusText.includes('変更ファイル') && fileCount > 0,
    `status="${statusText}" items=${fileCount}`
  );
  const authNoticeVisible = await page.evaluate(() => {
    const el = document.querySelector('#functions-tree-panel-host')
      ?.shadowRoot?.querySelector('.auth-notice');
    return !!el && getComputedStyle(el).display !== 'none' &&
      (el.textContent ?? '').includes('未認証モード');
  });
  record('panel: anonymous-mode notice shown', authNoticeVisible);
  await shot(page, '3-panel-file-list-anonymous');

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

  // === Phase 2: options ページと GitHub API のエラー経路 ===

  // 8. options ページを開く（拡張 ID は service worker の URL から取る）
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const extensionId = new URL(worker.url()).host;
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, {
    waitUntil: 'domcontentloaded',
  });
  await optionsPage.waitForFunction(
    () => (document.querySelector('#pat-status')?.textContent ?? '') !== '',
    undefined,
    { timeout: 10_000 }
  );
  const initialStatus = ((await optionsPage.locator('#pat-status').textContent()) ?? '').trim();
  record('options: opens with PAT unset', initialStatus.includes('未設定'), initialStatus);

  // 9. エラー経路その1: 存在しない PR 番号 → not_found（未認証のうちに確認）
  const notFound = await optionsPage.evaluate(
    ([owner, name]) =>
      chrome.runtime.sendMessage({
        type: 'GET_PR_FILES',
        pr: { owner, repo: name, pr: 99999999 },
      }),
    repo.split('/')
  );
  record(
    'error path: nonexistent PR -> not_found',
    notFound?.ok === false && notFound?.error?.kind === 'not_found',
    JSON.stringify(notFound?.error ?? notFound)
  );

  // 10. ダミー PAT の保存が chrome.storage.local に反映されること
  await optionsPage.fill('#pat-input', DUMMY_PAT);
  await optionsPage.click('#save');
  await optionsPage.waitForFunction(
    () => (document.querySelector('#pat-status')?.textContent ?? '').includes('保存済み'),
    undefined,
    { timeout: 10_000 }
  );
  const stored = await optionsPage.evaluate(() => chrome.storage.local.get('githubPat'));
  const savedStatus = ((await optionsPage.locator('#pat-status').textContent()) ?? '').trim();
  record(
    'options: PAT saved to chrome.storage.local (masked in UI)',
    stored.githubPat === DUMMY_PAT && !savedStatus.includes(DUMMY_PAT),
    savedStatus
  );
  await shot(optionsPage, '6-options-pat-saved');

  // 11. エラー経路その2: 無効 PAT で接続テスト → 401 が人間に読める形で出ること
  await optionsPage.click('#test');
  await optionsPage.waitForFunction(
    () => {
      const t = document.querySelector('#test-result')?.textContent ?? '';
      return t !== '' && !t.includes('テスト中');
    },
    undefined,
    { timeout: 30_000 }
  );
  const testText = ((await optionsPage.locator('#test-result').textContent()) ?? '').trim();
  record(
    'error path: connection test with invalid PAT -> 401 message',
    testText.includes('PAT が無効'),
    testText
  );
  await shot(optionsPage, '7-options-test-invalid-pat');

  // 12. PAT 削除が chrome.storage.local に反映されること
  await optionsPage.click('#delete');
  await optionsPage.waitForFunction(
    () => (document.querySelector('#pat-status')?.textContent ?? '').includes('未設定'),
    undefined,
    { timeout: 10_000 }
  );
  const cleared = await optionsPage.evaluate(() => chrome.storage.local.get('githubPat'));
  record('options: PAT deleted from chrome.storage.local', cleared.githubPat === undefined);
  await shot(optionsPage, '8-options-pat-deleted');
} catch (e) {
  record('e2e run', false, e.message);
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log('\n== summary ==');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}: ${r.name}`);
process.exitCode = failed ? 1 : 0;
