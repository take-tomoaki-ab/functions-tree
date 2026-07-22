// Playwright Chromium (open-source ビルド) に dist/ の拡張をロードし、
// 実際の GitHub PR ページで UI 注入と background 疎通を確認する。
//
// branded Chrome 137+ は --load-extension を無視するため channel: 'chromium' が必須。
//
// Phase 2 で追加した確認項目:
// - options ページで PAT の保存・削除が chrome.storage.local に反映される
// - エラー経路: 存在しない PR 番号 → not_found / 無効 PAT の接続テスト → 401 表示
//
// Phase 3 で追加した確認項目:
// - パネルを開くとコールグラフのサマリ（関数/呼び出し/解析/スキップ数）が表示される
// - パネルを閉じて開き直すと SW メモリキャッシュから返る（「（キャッシュ）」表示）
//
// Phase 4 で追加した確認項目:
// - パネルに mermaid の SVG グラフが描画される（色分けクラス + 凡例）
// - ノードクリックでサイドペインに関数詳細（名前 / 位置 / ソース / コメント欄）が出る
// - フィルタトグル（エッジのあるノードのみ）で表示ノード数が切り替わる
//
// Phase 5 で追加した確認項目:
// - 色分けが行レベル判定（commentable / inDiff / dep の 3 区分 + 凡例 3 項目）になる
// - コメント可能ノード: 対象行の表示 + 未認証ではボタン無効 + PAT 導線
// - コメント不可ノード: 理由の表示（diff 外 / 関数無変更）
// - PAT 未設定での投稿要求は background が pat_required で拒否（二重防御）
// - ダミー PAT 保存 → ボタンが自動で活性化し、投稿実行で 401 が人間可読で表示される
//   （実 PR への投稿はされない。無効 PAT のため GitHub 側で拒否される）
//
// レート制限（未認証 60 req/h）を消費するため、--pr で TypeScript ファイルを含む
// 小さめの PR を明示指定するのを推奨（未指定なら PR 一覧の先頭を使う）。
//
// usage: node scripts/e2e.mjs [--repo owner/name] [--pr number] [--out screenshot-dir]

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
const prNumber = argOf('--pr', null);
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

  // 2. PR ページへ（--pr 指定があれば直接、なければ PR 一覧の先頭を SPA 遷移で開く）
  let prHref;
  if (prNumber) {
    prHref = `/${repo}/pull/${prNumber}`;
    console.log(`  navigating to PR: ${prHref}`);
    await page.goto(`https://github.com${prHref}`, { waitUntil: 'domcontentloaded' });
  } else {
    await page.goto(`https://github.com/${repo}/pulls`, { waitUntil: 'domcontentloaded' });
    const prLink = page.locator(`a[href*="/${repo}/pull/"]`).first();
    await prLink.waitFor({ timeout: 30_000 });
    prHref = await prLink.getAttribute('href');
    console.log(`  navigating to PR: ${prHref}`);
    await prLink.click();
    await page.waitForURL(/\/pull\/\d+/, { timeout: 30_000 });
  }

  // 3. PR ページ: ボタンが注入されること
  await page.locator(BUTTON).waitFor({ timeout: 15_000 });
  record('PR page: button injected', true, prHref);
  await shot(page, '2-pr-page-button');

  // 4. ボタン押下でパネルが開き、コールグラフのサマリと mermaid の SVG が描画されること
  const waitForGraphStatus = () =>
    page.waitForFunction(
      () => {
        const t = document.querySelector('#functions-tree-panel-host')
          ?.shadowRoot?.querySelector('.status')?.textContent ?? '';
        return t !== '' && !t.includes('解析中');
      },
      undefined,
      { timeout: 90_000 } // 解析は contents API の取得回数に依存する
    );
  // 解析完了後も mermaid の動的 import + 描画が非同期に走るため、SVG（または空表示）を待つ
  const waitForGraphRender = () =>
    page.waitForFunction(
      () => {
        const shadow = document.querySelector('#functions-tree-panel-host')?.shadowRoot;
        return !!shadow?.querySelector('.graph-area svg, .graph-empty') ||
          !!shadow?.querySelector('.status[data-state="error"]');
      },
      undefined,
      { timeout: 60_000 }
    );
  const readPanel = () =>
    page.evaluate(() => {
      const shadow = document.querySelector('#functions-tree-panel-host')?.shadowRoot;
      return {
        status: (shadow?.querySelector('.status')?.textContent ?? '').trim(),
        svgCount: shadow?.querySelectorAll('.graph-area svg').length ?? 0,
        nodeCount: shadow?.querySelectorAll('.graph-area g.node').length ?? 0,
        commentableNodeCount:
          shadow?.querySelectorAll('.graph-area g.node.commentable').length ?? 0,
        inDiffNodeCount: shadow?.querySelectorAll('.graph-area g.node.inDiff').length ?? 0,
        depNodeCount: shadow?.querySelectorAll('.graph-area g.node.dep').length ?? 0,
        legendCount: shadow?.querySelectorAll('.legend-item').length ?? 0,
        countText: (shadow?.querySelector('.node-count')?.textContent ?? '').trim(),
      };
    });

  await page.locator(BUTTON).click();
  await page.locator(PANEL_STATUS).waitFor({ timeout: 10_000 });
  await waitForGraphStatus();
  await waitForGraphRender();
  const panel1 = await readPanel();
  record(
    'panel: graph summary rendered (nodes/edges/files/skips)',
    /関数 \d+ \/ 呼び出し \d+ \/ 解析 \d+ ファイル \/ スキップ \d+/.test(panel1.status),
    `status="${panel1.status}"`
  );
  record(
    'panel: mermaid SVG graph rendered',
    panel1.svgCount === 1 && panel1.nodeCount > 0,
    `svg=${panel1.svgCount} nodes=${panel1.nodeCount} (${panel1.countText})`
  );
  // コメント可ノードの存在は全ノード表示（フィルタ OFF 後の 6.5）で確認する
  // （この PR の変更行を含む関数は孤立ノードで、デフォルトフィルタでは非表示のため）
  record(
    'panel: commentable/inDiff/dep color classes + legend (line-level)',
    panel1.commentableNodeCount + panel1.inDiffNodeCount + panel1.depNodeCount ===
      panel1.nodeCount && panel1.legendCount === 3,
    `commentable=${panel1.commentableNodeCount} inDiff=${panel1.inDiffNodeCount} ` +
      `dep=${panel1.depNodeCount} legend=${panel1.legendCount}`
  );
  const authNoticeVisible = await page.evaluate(() => {
    const el = document.querySelector('#functions-tree-panel-host')
      ?.shadowRoot?.querySelector('.auth-notice');
    return !!el && getComputedStyle(el).display !== 'none' &&
      (el.textContent ?? '').includes('未認証モード');
  });
  record('panel: anonymous-mode notice shown', authNoticeVisible);
  await shot(page, '3-panel-mermaid-graph');

  // 5. ノードクリックでサイドペインに関数詳細（名前 / 位置 / ソース / コメント欄）が出ること
  const readDetail = () =>
    page.evaluate(() => {
      const shadow = document.querySelector('#functions-tree-panel-host')?.shadowRoot;
      return {
        name: (shadow?.querySelector('.detail-name')?.textContent ?? '').trim(),
        meta: (shadow?.querySelector('.detail-meta')?.textContent ?? '').trim(),
        sourceLength: (shadow?.querySelector('.source code')?.textContent ?? '').length,
        selectedCount: shadow?.querySelectorAll('.graph-area g.node.selected').length ?? 0,
        commentTarget: (shadow?.querySelector('.comment-target')?.textContent ?? '').trim(),
        hasCommentInput: !!shadow?.querySelector('.comment-input'),
        submitDisabled: shadow?.querySelector('.comment-submit')?.disabled ?? null,
        authNoticeVisible: (() => {
          const el = shadow?.querySelector('.comment-auth');
          return !!el && getComputedStyle(el).display !== 'none' &&
            !!el.querySelector('.open-options');
        })(),
        disabledReason: (shadow?.querySelector('.comment-disabled')?.textContent ?? '').trim(),
      };
    });

  await page.locator('#functions-tree-panel-host .graph-area g.node').first().click();
  const detail = await readDetail();
  record(
    'node click: side pane shows function detail with source',
    detail.name !== '' && /:\d+-\d+$/.test(detail.meta) &&
      detail.sourceLength > 0 &&
      (detail.hasCommentInput || detail.disabledReason !== '') &&
      detail.selectedCount === 1,
    `name=${detail.name} meta=${detail.meta} sourceLen=${detail.sourceLength} selected=${detail.selectedCount}`
  );
  await shot(page, '4-node-detail-source');

  // 6. フィルタトグル OFF（エッジのあるノードのみ → 全ノード）で表示が増えること
  await page.locator('#functions-tree-panel-host .filter-connected').click();
  await page.waitForFunction(
    (prev) => {
      const shadow = document.querySelector('#functions-tree-panel-host')?.shadowRoot;
      return (shadow?.querySelectorAll('.graph-area g.node').length ?? 0) > prev;
    },
    panel1.nodeCount,
    { timeout: 30_000 }
  );
  const panelAll = await readPanel();
  record(
    'filter toggle: showing all nodes increases rendered count',
    panelAll.nodeCount > panel1.nodeCount,
    `connectedOnly=${panel1.nodeCount} -> all=${panelAll.nodeCount} (${panelAll.countText})`
  );
  record(
    'all nodes view: commentable node exists (line-level mapping)',
    panelAll.commentableNodeCount > 0,
    `commentable=${panelAll.commentableNodeCount} / ${panelAll.nodeCount}`
  );
  await shot(page, '5-filter-all-nodes');

  // 6.3. コメント可能ノード: 対象行の表示 + 未認証ではボタン無効 + PAT 導線
  await page.locator('#functions-tree-panel-host .graph-area g.node.commentable').first().click();
  const cDetail = await readDetail();
  record(
    'commentable node: target line shown + submit disabled + PAT link (anonymous)',
    cDetail.hasCommentInput && cDetail.commentTarget.includes('にコメントされます') &&
      cDetail.submitDisabled === true && cDetail.authNoticeVisible,
    `target="${cDetail.commentTarget}" disabled=${cDetail.submitDisabled} authNotice=${cDetail.authNoticeVisible}`
  );
  await shot(page, '5b-commentable-node-anonymous');

  // === bugfix/keyboard-shortcut-leak ===
  // 6.4. パネル内のキー入力が shadow 境界を越えて document まで伝播しないこと。
  //      GitHub のショートカットハンドラは document で listen しているため、
  //      「document に keydown が届かない」= ショートカットが発動しない、の直接確認。
  await page.evaluate(() => {
    window.__ftLeakedKeys = [];
    document.addEventListener('keydown', (e) => window.__ftLeakedKeys.push(e.key));
  });
  await page.locator('#functions-tree-panel-host .comment-input').click();
  await page.keyboard.type('t');
  const keyInPanel = await page.evaluate(() => {
    const host = document.querySelector('#functions-tree-panel-host');
    return {
      leaked: window.__ftLeakedKeys.length,
      value: host?.shadowRoot?.querySelector('.comment-input')?.value ?? '',
      focusOnHost: document.activeElement === host,
    };
  });
  record(
    'keyboard: "t" in panel textarea does not leak keydown to document',
    keyInPanel.leaked === 0 && keyInPanel.value === 't' && keyInPanel.focusOnHost,
    `leaked=${keyInPanel.leaked} value="${keyInPanel.value}" focusOnHost=${keyInPanel.focusOnHost}`
  );
  await shot(page, '5b2-keyboard-in-panel-no-leak');
  // 後始末: 入力を空に戻す（以降のコメント欄確認に影響させない）
  await page.locator('#functions-tree-panel-host .comment-input').fill('');

  // 6.5. コメント不可ノード（diff 外 / 関数無変更）で理由が表示されること
  const nonCommentable = page.locator(
    '#functions-tree-panel-host .graph-area g.node:not(.commentable)'
  );
  if ((await nonCommentable.count()) > 0) {
    await nonCommentable.first().click();
    const ncDetail = await readDetail();
    record(
      'non-commentable node: reason shown, no comment form',
      (ncDetail.disabledReason.includes('関数は変更されていません') ||
        ncDetail.disabledReason.includes('diff 外のためコメント不可')) &&
        !ncDetail.hasCommentInput,
      `reason="${ncDetail.disabledReason}"`
    );
    await shot(page, '5c-non-commentable-reason');
  } else {
    record('non-commentable node: reason shown, no comment form', false,
      'この PR には コメント不可ノードがない（別の PR で確認要）');
  }

  // 7. 閉じて開き直すと SW メモリキャッシュから返ること（レート制限を消費しない）
  await page.locator(BUTTON).click(); // close
  await page.locator(BUTTON).click(); // reopen（フィルタはデフォルトに戻る）
  await waitForGraphStatus();
  await waitForGraphRender();
  const panel2 = await readPanel();
  record(
    'panel: second open served from SW cache',
    panel2.status.includes('（キャッシュ）') && panel2.nodeCount === panel1.nodeCount,
    `status="${panel2.status}" nodes=${panel2.nodeCount}`
  );
  await shot(page, '6-panel-graph-cached');

  // 8. 再度押下でパネルが閉じること
  await page.locator(BUTTON).click();
  const panelCount = await page.locator('#functions-tree-panel-host').count();
  record('panel: toggle closes panel', panelCount === 0, `count=${panelCount}`);

  // 9. SPA 遷移で PR ページを離れるとボタンが消えること（戻る = popstate）
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const buttonAfterLeave = await page.locator(BUTTON).count();
  record('SPA leave: button removed', buttonAfterLeave === 0, `count=${buttonAfterLeave}`);
  await shot(page, '7-spa-leave-no-button');

  // 10. SPA 遷移で PR ページに戻るとボタンが再注入されること
  await page.goForward({ waitUntil: 'domcontentloaded' });
  await page.locator(BUTTON).waitFor({ timeout: 15_000 });
  record('SPA re-enter: button re-injected', true);
  await shot(page, '8-spa-reenter-button');

  // === Phase 2: options ページと GitHub API のエラー経路 ===

  // 9. options ページを開く（拡張 ID は service worker の URL から取る）
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

  // 10. エラー経路その1: 存在しない PR 番号 → not_found（未認証のうちに確認）
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

  // 11. ダミー PAT の保存が chrome.storage.local に反映されること
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
  await shot(optionsPage, '9-options-pat-saved');

  // 12. エラー経路その2: 無効 PAT で接続テスト → 401 が人間に読める形で出ること
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
  await shot(optionsPage, '10-options-test-invalid-pat');

  // 13. PAT 削除が chrome.storage.local に反映されること
  await optionsPage.click('#delete');
  await optionsPage.waitForFunction(
    () => (document.querySelector('#pat-status')?.textContent ?? '').includes('未設定'),
    undefined,
    { timeout: 10_000 }
  );
  const cleared = await optionsPage.evaluate(() => chrome.storage.local.get('githubPat'));
  record('options: PAT deleted from chrome.storage.local', cleared.githubPat === undefined);
  await shot(optionsPage, '11-options-pat-deleted');

  // === Phase 5: レビューコメント投稿（実 PR には投稿されない検証のみ） ===

  // 14. PAT 未設定での投稿要求は background が pat_required で拒否すること（二重防御）
  const patRequired = await optionsPage.evaluate(
    ([owner, name]) =>
      chrome.runtime.sendMessage({
        type: 'POST_REVIEW_COMMENT',
        pr: { owner, repo: name, pr: 1 },
        commitId: 'deadbeef',
        path: 'src/x.ts',
        line: 1,
        body: 'e2e: should be rejected before reaching GitHub',
      }),
    repo.split('/')
  );
  record(
    'comment: post without PAT -> pat_required (no API call)',
    patRequired?.ok === false && patRequired?.error?.kind === 'pat_required',
    JSON.stringify(patRequired?.error ?? patRequired)
  );

  // 15. PR ページでパネルを開き直し（未認証・SW キャッシュ）、フィルタを外して
  //     コメント可能ノードを選択。本文を入れてもボタンは無効のまま（PAT 未設定）
  await page.bringToFront();
  await page.locator(BUTTON).click();
  await waitForGraphStatus();
  await waitForGraphRender();
  // コメント可能ノードが孤立ノードのことがあるため、全ノード表示に切り替える
  await page.locator('#functions-tree-panel-host .filter-connected').click();
  await page
    .locator('#functions-tree-panel-host .graph-area g.node.commentable')
    .first()
    .waitFor({ timeout: 30_000 });
  await page.locator('#functions-tree-panel-host .graph-area g.node.commentable').first().click();
  const commentText = 'e2e dummy comment（無効 PAT のため実投稿はされない）';
  await page.locator('#functions-tree-panel-host .comment-input').fill(commentText);
  const beforePat = await readDetail();
  record(
    'comment: body filled but submit still disabled without PAT',
    beforePat.submitDisabled === true && beforePat.authNoticeVisible,
    `disabled=${beforePat.submitDisabled} authNotice=${beforePat.authNoticeVisible}`
  );
  await shot(page, '12-comment-disabled-no-pat');

  // 16. 別タブの options でダミー PAT を保存 → storage.onChanged でボタンが自動活性化すること
  await optionsPage.fill('#pat-input', DUMMY_PAT);
  await optionsPage.click('#save');
  await optionsPage.waitForFunction(
    () => (document.querySelector('#pat-status')?.textContent ?? '').includes('保存済み'),
    undefined,
    { timeout: 10_000 }
  );
  await page.bringToFront();
  await page.waitForFunction(
    () => {
      const shadow = document.querySelector('#functions-tree-panel-host')?.shadowRoot;
      const submit = shadow?.querySelector('.comment-submit');
      return !!submit && submit.disabled === false;
    },
    undefined,
    { timeout: 10_000 }
  );
  const afterPat = await readDetail();
  record(
    'comment: submit auto-enabled after PAT saved (storage.onChanged)',
    afterPat.submitDisabled === false && !afterPat.authNoticeVisible &&
      afterPat.commentTarget.includes('にコメントされます'),
    `disabled=${afterPat.submitDisabled} target="${afterPat.commentTarget}"`
  );
  await shot(page, '13-comment-enabled-with-pat');

  // 17. 投稿実行 → 無効 PAT なので 401 が人間可読で表示されること（実投稿はされない）
  await page.locator('#functions-tree-panel-host .comment-submit').click();
  await page.waitForFunction(
    () => {
      const shadow = document.querySelector('#functions-tree-panel-host')?.shadowRoot;
      const el = shadow?.querySelector('.comment-status');
      return !!el && el.dataset.state !== 'posting' && (el.textContent ?? '') !== '';
    },
    undefined,
    { timeout: 30_000 }
  );
  const postResult = await page.evaluate(() => {
    const shadow = document.querySelector('#functions-tree-panel-host')?.shadowRoot;
    const el = shadow?.querySelector('.comment-status');
    return { state: el?.dataset.state ?? '', text: (el?.textContent ?? '').trim() };
  });
  record(
    'comment: post with invalid PAT -> human-readable 401 error',
    postResult.state === 'error' && postResult.text.includes('PAT が無効'),
    `state=${postResult.state} text="${postResult.text}"`
  );
  await shot(page, '14-comment-post-401');

  // 後始末: ダミー PAT を削除
  await optionsPage.click('#delete');
  await optionsPage.waitForFunction(
    () => (document.querySelector('#pat-status')?.textContent ?? '').includes('未設定'),
    undefined,
    { timeout: 10_000 }
  );

  // === bugfix/keyboard-shortcut-leak: Files changed タブでの実挙動確認 ===
  // GitHub の 't' ショートカットが実際に効くのは Files changed タブ
  // （左側ファイルツリーの検索フィルタにフォーカスが移る）なので、そこで
  // 「対照: パネル外では効く」「パネル内 textarea では効かない」の両方向を確認する。

  // 18. 対照: パネル外で 't' → ファイル検索（ページ側 input）にフォーカスが移ること
  //     （stopPropagation の入れすぎで GitHub 本来の挙動を壊していないことの確認）
  await page.bringToFront();
  await page.goto(`https://github.com${prHref}/files`, { waitUntil: 'domcontentloaded' });
  await page.locator(BUTTON).waitFor({ timeout: 15_000 });
  await page.keyboard.press('t');
  // ショートカットによるフォーカス移動は非同期のことがあるため少し待つ
  await page
    .waitForFunction(
      () => {
        const el = document.activeElement;
        return !!el && el !== document.body && el.id !== 'functions-tree-panel-host';
      },
      undefined,
      { timeout: 5_000 }
    )
    .catch(() => {});
  const outsideKey = await page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName ?? '',
      hint:
        el?.getAttribute('placeholder') ??
        el?.getAttribute('aria-label') ??
        el?.id ??
        '',
      onPanelHost: el?.id === 'functions-tree-panel-host',
    };
  });
  record(
    'files tab: "t" outside panel focuses GitHub file search (baseline intact)',
    (outsideKey.tag === 'INPUT' || outsideKey.tag === 'TEXTAREA') && !outsideKey.onPanelHost,
    `activeElement=${outsideKey.tag} "${outsideKey.hint}"`
  );
  await shot(page, '15-files-tab-t-outside-panel');
  // 後始末: フォーカスを外す（開いたオーバーレイがあれば Escape で閉じる）
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement) el.blur();
  });

  // 19. パネルの textarea にフォーカスして 't' をタイプ
  //     → GitHub のファイル検索は開かず（フォーカスはパネルのまま）、textarea に 't' が入ること
  await page.locator(BUTTON).click();
  await waitForGraphStatus();
  await waitForGraphRender();
  await page.locator('#functions-tree-panel-host .filter-connected').click();
  await page
    .locator('#functions-tree-panel-host .graph-area g.node.commentable')
    .first()
    .waitFor({ timeout: 30_000 });
  await page.locator('#functions-tree-panel-host .graph-area g.node.commentable').first().click();
  await page.locator('#functions-tree-panel-host .comment-input').click();
  await page.keyboard.type('t');
  const panelKey = await page.evaluate(() => {
    const host = document.querySelector('#functions-tree-panel-host');
    const active = document.activeElement;
    return {
      value: host?.shadowRoot?.querySelector('.comment-input')?.value ?? '',
      focusOnHost: active === host,
      activeTag: active?.tagName ?? '',
      activeHint:
        active?.getAttribute('placeholder') ?? active?.getAttribute('aria-label') ?? active?.id ?? '',
    };
  });
  record(
    'files tab: "t" in panel textarea types into textarea, GitHub file search not triggered',
    panelKey.value === 't' && panelKey.focusOnHost,
    `value="${panelKey.value}" focusOnHost=${panelKey.focusOnHost} ` +
      `activeElement=${panelKey.activeTag} "${panelKey.activeHint}"`
  );
  await shot(page, '16-files-tab-t-in-panel');
} catch (e) {
  record('e2e run', false, e.message);
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log('\n== summary ==');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}: ${r.name}`);
process.exitCode = failed ? 1 : 0;
