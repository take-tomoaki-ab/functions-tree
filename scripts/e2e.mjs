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
// - 色分けが行レベル判定（commentable / inDiff / dep の 3 区分）になる
// - コメント可能ノード: 対象行の表示 / コメント不可ノード: 理由の表示（diff 外 / 関数無変更）
// - PAT 未設定での投稿要求は background が pat_required で拒否（二重防御）
//
// feat/batch-review-comments で追加した確認項目（多くは pending-review-integration で置換）:
// - 下書きの一覧表示（件数バッジ + グラフ上の has-draft マーク）と編集・削除の UI
//
// feat/pending-review-integration で追加した確認項目:
// - 下書きが GitHub ネイティブの pending review に統合され、拡張独自のローカルキュー
//   （chrome.storage.session）は廃止（下書き操作はすべて PAT 必須になった）
// - 未認証時: 「下書きに追加」無効 + PAT 導線（コメントフォーム・下書きペインの両方）
// - GET_PENDING_REVIEW は PAT 未設定でもエラーでなく「pending review なし」を返す
// - ADD_PENDING_COMMENT / SUBMIT_PENDING_REVIEW は PAT 未設定なら pat_required で拒否
// - ダミー PAT 保存 → 「下書きに追加」が自動活性化（storage.onChanged）し、
//   pending review 取得の 401 が人間可読で表示される。「下書きに追加」も 401 が
//   表示され、下書きは増えない（実 PR への下書き作成・投稿はされない）
//
// feat/syntax-highlight で追加した確認項目:
// - ノード詳細のソースがシンタックスハイライトされる（.source code 内に tok-* の span）
//
// feat/mermaid-zoom で追加した確認項目:
// - グラフ領域右上のズームコントロール（＋ / − / リセット / 倍率表示）で
//   SVG の width/height が倍率どおりに変わる（viewBox は据え置き）
// - Ctrl/Cmd + ホイールでもズームできる（カーソル位置基準）
// - リセットで 100%（基準サイズ）に戻る
//
// bugfix/issue-10-yellow-node-comment で追加した確認項目:
// - 黄色ノード（差分はないが diff コンテキスト内でコメント可能）に実際にコメント
//   フォームが出ること（本当にコメント不可なのは .dep クラスのノードだけ）
//
// feat/issue-11-code-diff-highlight で追加した確認項目:
// - ノード詳細のソースが git diff 風の行単位表示になる（行番号ガター + +/- マーカー）
// - 行番号ガターの両端が `path:start-end` の行範囲と一致する
// - 追加行は緑背景 + `+`、削除行は行番号なし + `-` で赤背景、`+n -m` サマリが出る
//
// feat/issue-13-analysis-result-cache で追加した確認項目:
// - 解析結果のキャッシュが chrome.storage.session に永続化される（issue #13: パネルの
//   開閉のたびに再計算されるのを解消）
// - パネルヘッダーの「再解析」ボタンでキャッシュを無視して強制再計算できる
//   （キャッシュヒット中でも明示的な再計算の導線が失われていないこと）
// - CDP で SW（service worker）を強制終了し、パネル再オープンでの再起動をまたいでも
//   キャッシュがヒットすること（旧実装の SW メモリの Map は SW 再起動で必ず消えていた）
//
// feat/issue-14-resizable-code-area で追加した確認項目:
// - コード表示エリア（.source）が右下ハンドルのドラッグでリサイズできる
//   （CSS resize: vertical）
// - リサイズした高さが chrome.storage.local に保存され、パネルを閉じて
//   開き直しても復元される
//
// レート制限（未認証 60 req/h）を消費するため、--pr で TypeScript ファイルを含む
// 小さめの PR を明示指定するのを推奨（未指定なら PR 一覧の先頭を使う）。
//
// スクリーンショットはデフォルトで screenshots/ に出力する（--out で変更可）。
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
const outDir = argOf('--out', 'screenshots');
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

  // 3b. スクロールでヘッダーが画面外に出てもボタンが押せる位置に残ること（fixed 追従）。
  //     未ログイン（headless e2e）ではヘッダーのアクション領域が d-none のため、
  //     ボタンは最初からフォールバックの fixed 表示になる。その場合は
  //     「スクロールしても viewport 内に見えている」ことだけを確認し、
  //     アンカーが可視のとき（ログイン時相当）のみ inline ⇔ fixed の遷移も確認する
  //     （遷移そのものの決定的な検証は、アンカー可視の偽 PR ページを route で
  //     差し込む方式で実装時に確認済み）。
  const buttonMode = await page.evaluate(() => {
    const b = document.getElementById('functions-tree-toggle');
    return b?.parentElement === document.body ? 'fallback-fixed' : 'anchored';
  });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page
    .waitForFunction(
      () => {
        const b = document.getElementById('functions-tree-toggle');
        return !!b && getComputedStyle(b).position === 'fixed';
      },
      undefined,
      { timeout: 5_000 }
    )
    .catch(() => {});
  const floatedStyle = await page.evaluate(() => {
    const b = document.getElementById('functions-tree-toggle');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return {
      position: getComputedStyle(b).position,
      inViewport: r.top >= 0 && r.bottom <= innerHeight && r.width > 0,
      // Files changed タブ等では sticky ツールバーの Submit ボタンの左に移動する
      dockedBySubmit:
        b.nextElementSibling instanceof HTMLElement &&
        /ReviewMenuButton/.test(b.nextElementSibling.className),
    };
  });
  record(
    `scroll: button stays reachable when header scrolled out [${buttonMode}]`,
    (floatedStyle?.position === 'fixed' || floatedStyle?.dockedBySubmit === true) &&
      floatedStyle.inViewport,
    JSON.stringify(floatedStyle)
  );
  await shot(page, '2b-button-floating-on-scroll');
  await page.evaluate(() => window.scrollTo(0, 0));
  if (buttonMode === 'anchored') {
    await page
      .waitForFunction(
        () => {
          const b = document.getElementById('functions-tree-toggle');
          return !!b && getComputedStyle(b).position !== 'fixed';
        },
        undefined,
        { timeout: 5_000 }
      )
      .catch(() => {});
  }
  const topStyle = await page.evaluate(() => {
    const b = document.getElementById('functions-tree-toggle');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return {
      position: getComputedStyle(b).position,
      inViewport: r.top >= 0 && r.bottom <= innerHeight && r.width > 0,
    };
  });
  record(
    'scroll: button visible again at top (inline when anchored)',
    buttonMode === 'anchored'
      ? topStyle?.position !== 'fixed' && topStyle?.inViewport === true
      : topStyle?.position === 'fixed' && topStyle?.inViewport === true,
    `mode=${buttonMode} ${JSON.stringify(topStyle)}`
  );

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
    'panel: commentable/inDiff/dep color classes + legend (line-level + draft)',
    panel1.commentableNodeCount + panel1.inDiffNodeCount + panel1.depNodeCount ===
      panel1.nodeCount && panel1.legendCount === 4,
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

  // 4b. ズームコントロール: ＋/− で SVG サイズが倍率どおりに変わり、リセットで戻ること。
  //     viewBox は据え置き（width/height 属性だけで拡縮する実装）であることも確認する
  const readZoom = () =>
    page.evaluate(() => {
      const shadow = document.querySelector('#functions-tree-panel-host')?.shadowRoot;
      const svg = shadow?.querySelector('.graph-area svg');
      return {
        width: svg ? Number(svg.getAttribute('width')) : 0,
        height: svg ? Number(svg.getAttribute('height')) : 0,
        viewBox: svg?.getAttribute('viewBox') ?? '',
        label: (shadow?.querySelector('.zoom-level')?.textContent ?? '').trim(),
        resetDisabled: shadow?.querySelector('.zoom-reset')?.disabled ?? null,
      };
    });
  const zoomBase = await readZoom();
  record(
    'zoom: starts at 100% (reset disabled)',
    zoomBase.label === '100%' && zoomBase.resetDisabled === true && zoomBase.width > 0,
    `label=${zoomBase.label} width=${zoomBase.width}`
  );
  await page.locator('#functions-tree-panel-host .zoom-in').click();
  const zoomedIn = await readZoom();
  record(
    'zoom: + button enlarges svg to 125% (viewBox unchanged)',
    Math.abs(zoomedIn.width - zoomBase.width * 1.25) < 0.5 &&
      zoomedIn.label === '125%' && zoomedIn.viewBox === zoomBase.viewBox,
    `width=${zoomBase.width} -> ${zoomedIn.width} label=${zoomedIn.label}`
  );
  await shot(page, '3b-zoom-in-125');
  await page.locator('#functions-tree-panel-host .zoom-out').click();
  await page.locator('#functions-tree-panel-host .zoom-out').click();
  const zoomedOut = await readZoom();
  record(
    'zoom: − button shrinks svg to 80%',
    Math.abs(zoomedOut.width - zoomBase.width * 0.8) < 0.5 && zoomedOut.label === '80%',
    `width=${zoomedOut.width} label=${zoomedOut.label}`
  );
  // Ctrl/Cmd + ホイール（上スクロール = 拡大）。実イベントと同じ合成 WheelEvent を
  // .graph-scroll に流す（Playwright の mouse.wheel は修飾キーを載せられないため）
  await page.evaluate(() => {
    const shadow = document.querySelector('#functions-tree-panel-host')?.shadowRoot;
    const scroll = shadow?.querySelector('.graph-scroll');
    const r = scroll.getBoundingClientRect();
    scroll.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -120,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      })
    );
  });
  const zoomedWheel = await readZoom();
  record(
    'zoom: ctrl+wheel up enlarges svg',
    zoomedWheel.width > zoomedOut.width && zoomedWheel.label !== zoomedOut.label,
    `width=${zoomedOut.width} -> ${zoomedWheel.width} label=${zoomedWheel.label}`
  );
  await page.locator('#functions-tree-panel-host .zoom-reset').click();
  const zoomedReset = await readZoom();
  record(
    'zoom: reset returns to 100% (base size)',
    zoomedReset.width === zoomBase.width && zoomedReset.label === '100%' &&
      zoomedReset.resetDisabled === true,
    `width=${zoomedReset.width} label=${zoomedReset.label}`
  );
  await shot(page, '3c-zoom-reset');

  // 5. ノードクリックでサイドペインに関数詳細（名前 / 位置 / ソース / コメント欄）が出ること
  const readDetail = () =>
    page.evaluate(() => {
      const shadow = document.querySelector('#functions-tree-panel-host')?.shadowRoot;
      return {
        name: (shadow?.querySelector('.detail-name')?.textContent ?? '').trim(),
        meta: (shadow?.querySelector('.detail-meta')?.textContent ?? '').trim(),
        sourceLength: (shadow?.querySelector('.source code')?.textContent ?? '').length,
        // シンタックスハイライトの span（種別の内訳も検証ログに出す）
        tokenKinds: [
          ...[...(shadow?.querySelectorAll('.source code [class^="tok-"]') ?? [])]
            .reduce((acc, s) => acc.set(s.className, (acc.get(s.className) ?? 0) + 1), new Map())
            .entries(),
        ],
        selectedCount: shadow?.querySelectorAll('.graph-area g.node.selected').length ?? 0,
        commentTarget: (shadow?.querySelector('.comment-target')?.textContent ?? '').trim(),
        hasCommentInput: !!shadow?.querySelector('.comment-input'),
        inputValue: shadow?.querySelector('.comment-input')?.value ?? '',
        addDisabled: shadow?.querySelector('.draft-add')?.disabled ?? null,
        addLabel: (shadow?.querySelector('.draft-add')?.textContent ?? '').trim(),
        removeVisible: (() => {
          const el = shadow?.querySelector('.draft-remove');
          return !!el && !el.hidden;
        })(),
        commentAuthVisible: (() => {
          const el = shadow?.querySelector('.comment-auth');
          return !!el && getComputedStyle(el).display !== 'none';
        })(),
        commentStatusState:
          shadow?.querySelector('.comment-status')?.dataset.state ?? '',
        commentStatusText:
          (shadow?.querySelector('.comment-status')?.textContent ?? '').trim(),
        disabledReason: (shadow?.querySelector('.comment-disabled')?.textContent ?? '').trim(),
        // feat/issue-11-code-diff-highlight: git diff 風の行単位表示
        diffRows: (() => {
          const rows = [...(shadow?.querySelectorAll('.source code .src-line') ?? [])];
          const has = (r, c) => r.classList.contains(c);
          return {
            total: rows.length,
            add: rows.filter((r) => has(r, 'src-add')).length,
            del: rows.filter((r) => has(r, 'src-del')).length,
            context: rows.filter((r) => has(r, 'src-context')).length,
          };
        })(),
        // 行番号ガター（削除行は行番号なしなので、番号のある最初/最後の行を見る）
        numberedLines: (() => {
          const nos = [...(shadow?.querySelectorAll('.source code .src-line') ?? [])]
            .map((r) => (r.querySelector('.src-lineno')?.textContent ?? '').trim())
            .filter((t) => t !== '');
          return { first: nos[0] ?? '', last: nos[nos.length - 1] ?? '' };
        })(),
        // 追加行 / 削除行 / 文脈行の見た目（マーカー文字と実効背景色）
        rowStyles: (() => {
          const pick = (cls) => {
            const r = shadow?.querySelector(`.source code .src-line.${cls}`);
            if (!r) return null;
            return {
              marker: r.querySelector('.src-marker')?.textContent ?? '',
              lineNo: (r.querySelector('.src-lineno')?.textContent ?? '').trim(),
              bg: getComputedStyle(r).backgroundColor,
            };
          };
          return { add: pick('src-add'), del: pick('src-del'), context: pick('src-context') };
        })(),
        diffStat: (shadow?.querySelector('.diff-stat')?.textContent ?? '').trim(),
      };
    });

  // 下書き一覧ペイン（件数バッジ / 一覧 / まとめて送信ボタン / グラフ上のマーク）の状態
  const readDrafts = () =>
    page.evaluate(() => {
      const shadow = document.querySelector('#functions-tree-panel-host')?.shadowRoot;
      const items = [...(shadow?.querySelectorAll('.draft-item') ?? [])].map((li) => ({
        name: (li.querySelector('.draft-node-name')?.textContent ?? '').trim(),
        loc: (li.querySelector('.draft-loc')?.textContent ?? '').trim(),
        preview: (li.querySelector('.draft-preview')?.textContent ?? '').trim(),
      }));
      const submit = shadow?.querySelector('.review-submit');
      const auth = shadow?.querySelector('.drafts-auth');
      const status = shadow?.querySelector('.review-status');
      return {
        count: (shadow?.querySelector('.drafts-count')?.textContent ?? '').trim(),
        items,
        submitDisabled: submit?.disabled ?? null,
        submitLabel: (submit?.textContent ?? '').trim(),
        authVisible: !!auth && getComputedStyle(auth).display !== 'none' &&
          !!auth.querySelector('.open-options'),
        statusState: status?.dataset.state ?? '',
        statusText: (status?.textContent ?? '').trim(),
        draftMarks: shadow?.querySelectorAll('.graph-area g.node.has-draft').length ?? 0,
        // マークが視覚的にも効いていること（mermaid の classDef に負けていないこと）の確認
        markStroke: (() => {
          const shape = shadow?.querySelector(
            '.graph-area g.node.has-draft rect, .graph-area g.node.has-draft polygon, .graph-area g.node.has-draft path'
          );
          return shape ? getComputedStyle(shape).stroke : '';
        })(),
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
  record(
    'node detail: source is syntax highlighted (tok-* spans)',
    detail.tokenKinds.reduce((n, [, c]) => n + c, 0) > 0,
    `kinds=${JSON.stringify(detail.tokenKinds)}`
  );
  await shot(page, '4-node-detail-source');

  // 5a. コード表示エリア（.source）は右下ハンドルでリサイズできること（issue #14）。
  //     ブラウザネイティブの CSS resize: vertical によるハンドルを実際にドラッグする
  const readSourceRect = () =>
    page.evaluate(() => {
      const el = document
        .querySelector('#functions-tree-panel-host')
        ?.shadowRoot?.querySelector('.source');
      const r = el?.getBoundingClientRect();
      return r ? { width: r.width, height: r.height, right: r.right, bottom: r.bottom } : null;
    });
  const sourceRectBefore = await readSourceRect();
  let sourceRectAfter = null;
  if (sourceRectBefore) {
    const handleX = sourceRectBefore.right - 6;
    const handleY = sourceRectBefore.bottom - 6;
    await page.mouse.move(handleX, handleY);
    await page.mouse.down();
    await page.mouse.move(handleX, handleY + 100, { steps: 10 });
    await page.mouse.up();
    sourceRectAfter = await readSourceRect();
    record(
      'source pane: drag handle resizes code area height',
      !!sourceRectAfter && sourceRectAfter.height > sourceRectBefore.height + 30,
      `before=${sourceRectBefore.height} after=${sourceRectAfter?.height}`
    );
    await shot(page, '4b-source-resized');
  } else {
    record('source pane: drag handle resizes code area height', false, '.source not found');
  }

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

  // 6.3. コメント可能ノード: 対象行の表示 + 未認証では「下書きに追加」が無効で
  //      PAT 導線が出ること（下書きは GitHub の pending review に保存されるため
  //      追加の時点から PAT が必要）
  await page.locator('#functions-tree-panel-host .graph-area g.node.commentable').first().click();
  const cDetail = await readDetail();
  record(
    'commentable node: target line shown + add-draft disabled + PAT hint while anonymous',
    cDetail.hasCommentInput && cDetail.commentTarget.includes('にコメントされます') &&
      cDetail.addDisabled === true && cDetail.addLabel === '下書きに追加' &&
      cDetail.commentAuthVisible && !cDetail.removeVisible,
    `target="${cDetail.commentTarget}" addDisabled=${cDetail.addDisabled} ` +
      `label="${cDetail.addLabel}" authVisible=${cDetail.commentAuthVisible}`
  );
  const emptyDrafts = await readDrafts();
  record(
    'drafts pane: starts empty (count 0, submit disabled, PAT hint shown)',
    emptyDrafts.count === '0' && emptyDrafts.submitDisabled === true &&
      emptyDrafts.items.length === 0 && emptyDrafts.authVisible,
    `count=${emptyDrafts.count} submitDisabled=${emptyDrafts.submitDisabled} ` +
      `authVisible=${emptyDrafts.authVisible}`
  );
  await shot(page, '5b-commentable-node-anonymous');

  // === feat/issue-11-code-diff-highlight ===
  // 6.3b. パネル内のソースが git diff 風に行単位でハイライトされること。
  //       コメント可能ノードは「追加行あり」と「文脈行のみ」の両方があり得るので、
  //       追加行を持つノードが見つかるまで順にクリックして探す。
  const commentableNodes = page.locator(
    '#functions-tree-panel-host .graph-area g.node.commentable'
  );
  const commentableTotal = await commentableNodes.count();
  let anyRows = null; // 行表示が出た最初のノード
  let withAdd = null; // 追加行を含むノード
  for (let i = 0; i < Math.min(commentableTotal, 15); i++) {
    await commentableNodes.nth(i).click();
    const d = await readDetail();
    if (!anyRows && d.diffRows.total > 0) anyRows = d;
    if (d.diffRows.add > 0) {
      withAdd = d;
      break;
    }
  }
  const rowsDetail = anyRows ?? (await readDetail());
  // 行の内訳が総数と一致 = すべての行が add / del / context のどれかに分類されている。
  // 行番号ガターの両端が `path:start-end` の範囲と一致 = ファイルの実行番号に対応している
  const metaRange = /:(\d+)-(\d+)$/.exec(rowsDetail.meta);
  record(
    'node detail: source is rendered as diff rows (line-number gutter + markers)',
    rowsDetail.diffRows.total > 0 &&
      rowsDetail.diffRows.add + rowsDetail.diffRows.del + rowsDetail.diffRows.context ===
        rowsDetail.diffRows.total &&
      metaRange !== null &&
      rowsDetail.numberedLines.first === metaRange[1] &&
      rowsDetail.numberedLines.last === metaRange[2] &&
      // 文脈行はマーカーなし（新規追加された関数は全行 add で文脈行が無いこともある）
      (rowsDetail.rowStyles.context === null ||
        rowsDetail.rowStyles.context.marker === ' '),
    `rows=${JSON.stringify(rowsDetail.diffRows)} gutter=${rowsDetail.numberedLines.first}-` +
      `${rowsDetail.numberedLines.last} meta=${rowsDetail.meta}`
  );
  if (withAdd) {
    const add = withAdd.rowStyles.add;
    const ctx = withAdd.rowStyles.context;
    // 追加行は `+` マーカー + 行番号あり + 文脈行とは異なる（透明でない）背景色
    record(
      'node detail: added lines highlighted with + marker and green background',
      add !== null && add.marker === '+' && /^\d+$/.test(add.lineNo) &&
        add.bg !== 'rgba(0, 0, 0, 0)' && add.bg !== ctx?.bg &&
        withAdd.diffStat.startsWith(`+${withAdd.diffRows.add}`),
      `add=${JSON.stringify(add)} contextBg=${ctx?.bg} stat="${withAdd.diffStat}"`
    );
    // 削除行は同じノードにあるとは限らないので、あるときだけ検証する
    const del = withAdd.rowStyles.del;
    record(
      'node detail: deleted lines shown as - rows without line numbers',
      del === null || (del.marker === '-' && del.lineNo === '' &&
        del.bg !== 'rgba(0, 0, 0, 0)' && del.bg !== add?.bg),
      del === null
        ? `このノードに削除行なし（del=${withAdd.diffRows.del}）`
        : `del=${JSON.stringify(del)}`
    );
    await shot(page, '5b1-node-detail-diff-highlight');
  } else {
    record(
      'node detail: added lines highlighted with + marker and green background',
      false,
      `追加行を持つコメント可能ノードが見つからない（commentable=${commentableTotal}）`
    );
  }
  // 以降のコメント欄確認のためコメント可能ノードを選び直す
  await commentableNodes.first().click();

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

  // 6.5. コメント不可ノード（diff 外 / hunk に一切掛からない）で理由が表示されること
  //      .commentable と .inDiff（差分なしだがコメント可）はどちらも投稿可能なので、
  //      「本当にコメント不可」なのは .dep クラスのノードだけ（issue #10 の修正後の分類）
  const nonCommentable = page.locator(
    '#functions-tree-panel-host .graph-area g.node.dep'
  );
  if ((await nonCommentable.count()) > 0) {
    await nonCommentable.first().click();
    const ncDetail = await readDetail();
    record(
      'non-commentable node (gray): reason shown, no comment form',
      (ncDetail.disabledReason.includes('関数は変更されていません') ||
        ncDetail.disabledReason.includes('diff 外のためコメント不可')) &&
        !ncDetail.hasCommentInput,
      `reason="${ncDetail.disabledReason}"`
    );
    await shot(page, '5c-non-commentable-reason');
  } else {
    record('non-commentable node (gray): reason shown, no comment form', false,
      'この PR には コメント不可ノードがない（別の PR で確認要）');
  }

  // 6.6. issue #10 回帰: 黄色ノード（差分なしだがコメント可能）は実際にコメントフォームが
  //      出ること（disabled 理由ではなく対象行が表示される）
  const inDiffOnly = page.locator(
    '#functions-tree-panel-host .graph-area g.node.inDiff'
  );
  if ((await inDiffOnly.count()) > 0) {
    await inDiffOnly.first().click();
    const yDetail = await readDetail();
    record(
      'issue #10 regression: yellow node (no diff, in diff context) is commentable',
      yDetail.hasCommentInput && yDetail.commentTarget.includes('にコメントされます') &&
        yDetail.disabledReason === '',
      `hasCommentInput=${yDetail.hasCommentInput} target="${yDetail.commentTarget}" ` +
        `disabledReason="${yDetail.disabledReason}"`
    );
    await shot(page, '5d-indiff-node-commentable');
  } else {
    record(
      'issue #10 regression: yellow node (no diff, in diff context) is commentable',
      false,
      'この PR には黄色（差分なしだがコメント可能）ノードがない（別の PR で確認要）'
    );
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

  // 7b. issue #13: 「再解析」ボタンでキャッシュを無視して強制的に再計算できること
  //     （キャッシュヒット中でも明示的な再計算の導線が失われていないことの確認）
  await page.locator('#functions-tree-panel-host .graph-refresh').click();
  await waitForGraphStatus();
  await waitForGraphRender();
  const panelForced = await readPanel();
  record(
    'panel: 再解析 button forces recompute (bypasses cache, same node count)',
    !panelForced.status.includes('（キャッシュ）') && panelForced.nodeCount === panel1.nodeCount,
    `status="${panelForced.status}"`
  );
  await shot(page, '6b-panel-graph-force-refresh');

  // 7c. issue #13 の本丸: SW を強制終了（サスペンド相当）しても、パネルを再度開いた
  //     ときにキャッシュヒットし、再計算されないこと。旧実装（SW メモリの Map）では
  //     SW 再起動でキャッシュが必ず消えていたが、chrome.storage.session への永続化で
  //     再起動をまたいでも復元されることを確認する。
  const cdp = await context.newCDPSession(page);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const swTarget = targetInfos.find((t) => t.type === 'service_worker');
  record(
    'e2e setup: found service worker target to force-restart',
    !!swTarget,
    JSON.stringify(swTarget?.url ?? null)
  );
  if (swTarget) {
    await cdp.send('Target.closeTarget', { targetId: swTarget.targetId });
    // SW が完全に落ちてから、パネル開閉のメッセージ送信で再起動をトリガーする
    await page.waitForTimeout(500);
  }
  await page.locator(BUTTON).click(); // close
  await page.locator(BUTTON).click(); // reopen（SW 再起動をまたぐ）
  await waitForGraphStatus();
  await waitForGraphRender();
  const panelAfterSwRestart = await readPanel();
  record(
    'panel: cache survives SW restart (chrome.storage.session persists, not lost like an in-memory Map)',
    panelAfterSwRestart.status.includes('（キャッシュ）') &&
      panelAfterSwRestart.nodeCount === panel1.nodeCount,
    `status="${panelAfterSwRestart.status}"`
  );
  await shot(page, '6c-panel-graph-cache-survives-sw-restart');

  // 7d. リサイズしたコード表示エリアの高さが記憶され、パネルを閉じて開き直しても
  //     （chrome.storage.local への保存を経由して）復元されること（issue #14）
  await page.locator('#functions-tree-panel-host .graph-area g.node').first().click();
  const sourceRectRestored = await readSourceRect();
  record(
    'source pane: resized height is remembered across panel reopen',
    !!sourceRectAfter && !!sourceRectRestored &&
      Math.abs(sourceRectRestored.height - sourceRectAfter.height) <= 2,
    `resized=${sourceRectAfter?.height} restored=${sourceRectRestored?.height}`
  );
  await shot(page, '6d-source-height-restored');

  // 8. 再度押下でパネルが閉じること
  await page.locator(BUTTON).click();
  const panelCount = await page.locator('#functions-tree-panel-host').count();
  record('panel: toggle closes panel', panelCount === 0, `count=${panelCount}`);

  // 8b. Esc キーでもパネルが閉じること（SW キャッシュから開き直して確認）
  await page.locator(BUTTON).click();
  await waitForGraphStatus();
  await waitForGraphRender();
  await page.keyboard.press('Escape');
  const panelAfterEsc = await page.locator('#functions-tree-panel-host').count();
  record('panel: Escape closes panel', panelAfterEsc === 0, `count=${panelAfterEsc}`);

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

  // === pending review 統合: 下書き操作の検証（実 PR には下書きも投稿もされない） ===

  // 14. PAT 未設定の GET_PENDING_REVIEW はエラーでなく「pending review なし」を返すこと
  //     （未認証では pending review は存在し得ないため、パネルを開いただけで
  //     エラー表示にならない）
  const anonPending = await optionsPage.evaluate(
    ([owner, name]) =>
      chrome.runtime.sendMessage({
        type: 'GET_PENDING_REVIEW',
        pr: { owner, repo: name, pr: 1 },
      }),
    repo.split('/')
  );
  record(
    'pending review: GET without PAT -> ok with empty state (no API call)',
    anonPending?.ok === true && anonPending?.value?.reviewId === null &&
      Array.isArray(anonPending?.value?.comments) &&
      anonPending.value.comments.length === 0,
    JSON.stringify(anonPending)
  );

  // 14b. 書き込み系（下書き追加 / レビュー送信）は PAT 未設定なら GitHub に到達する前に
  //      pat_required で拒否されること（UI 側のボタン無効化との二重防御）
  const addPatRequired = await optionsPage.evaluate(
    ([owner, name]) =>
      chrome.runtime.sendMessage({
        type: 'ADD_PENDING_COMMENT',
        pr: { owner, repo: name, pr: 1 },
        commitId: 'deadbeef',
        path: 'src/x.ts',
        line: 1,
        body: 'e2e: should be rejected before reaching GitHub',
      }),
    repo.split('/')
  );
  record(
    'pending review: add comment without PAT -> pat_required (no API call)',
    addPatRequired?.ok === false && addPatRequired?.error?.kind === 'pat_required',
    JSON.stringify(addPatRequired?.error ?? addPatRequired)
  );
  const submitPatRequired = await optionsPage.evaluate(
    ([owner, name]) =>
      chrome.runtime.sendMessage({
        type: 'SUBMIT_PENDING_REVIEW',
        pr: { owner, repo: name, pr: 1 },
        reviewId: 'PRR_dummy',
      }),
    repo.split('/')
  );
  record(
    'pending review: submit without PAT -> pat_required (no API call)',
    submitPatRequired?.ok === false && submitPatRequired?.error?.kind === 'pat_required',
    JSON.stringify(submitPatRequired?.error ?? submitPatRequired)
  );

  // 15. PR ページでパネルを開き直し（未認証・SW キャッシュ）、フィルタを外して
  //     コメント可能ノードに本文を入れても、PAT 未設定の間は「下書きに追加」が
  //     無効のまま（PAT 導線が出続ける）であること
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
  await page
    .locator('#functions-tree-panel-host .comment-input')
    .fill('e2e 下書き（GitHub の pending review に保存される想定）');
  const filledAnon = await readDetail();
  record(
    'drafts: add stays disabled with body while anonymous (PAT hint shown)',
    filledAnon.addDisabled === true && filledAnon.commentAuthVisible,
    `addDisabled=${filledAnon.addDisabled} authVisible=${filledAnon.commentAuthVisible}`
  );
  await shot(page, '12-add-disabled-anonymous');

  // 16. 別タブの options でダミー PAT を保存 → storage.onChanged で「下書きに追加」が
  //     自動活性化すること（書きかけの本文は消えない）。同時に pending review の
  //     取得が走り、無効 PAT なので 401 が人間可読で表示されること（エラー経路）
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
      const add = shadow?.querySelector('.draft-add');
      const status = shadow?.querySelector('.review-status');
      // 追加ボタンの活性化と pending review 取得（401 エラー表示）の両方を待つ
      return !!add && add.disabled === false &&
        !!status && status.dataset.state === 'error';
    },
    undefined,
    { timeout: 15_000 }
  );
  const enabledDetail = await readDetail();
  const pendingFetch = await readDrafts();
  record(
    'drafts: add auto-enabled after PAT saved (storage.onChanged, body kept)',
    enabledDetail.addDisabled === false && !enabledDetail.commentAuthVisible &&
      enabledDetail.inputValue.includes('e2e 下書き'),
    `addDisabled=${enabledDetail.addDisabled} authVisible=${enabledDetail.commentAuthVisible} ` +
      `input="${enabledDetail.inputValue}"`
  );
  record(
    'pending review: fetch with invalid PAT -> human-readable 401',
    pendingFetch.statusState === 'error' && pendingFetch.statusText.includes('PAT が無効'),
    `state=${pendingFetch.statusState} text="${pendingFetch.statusText}"`
  );
  await shot(page, '13-add-enabled-after-pat');

  // 17. 「下書きに追加」→ 無効 PAT なので 401 が人間可読で表示され、下書きは増えないこと
  //     （実 PR に pending review は作られない。GitHub 側で拒否される）
  await page.locator('#functions-tree-panel-host .draft-add').click();
  await page.waitForFunction(
    () => {
      const shadow = document.querySelector('#functions-tree-panel-host')?.shadowRoot;
      const el = shadow?.querySelector('.comment-status');
      return !!el && el.dataset.state !== 'posting' && (el.textContent ?? '') !== '';
    },
    undefined,
    { timeout: 30_000 }
  );
  const addResult = await readDetail();
  const draftsAfterAdd = await readDrafts();
  record(
    'drafts: add with invalid PAT -> human-readable 401, no draft created',
    addResult.commentStatusState === 'error' &&
      addResult.commentStatusText.includes('PAT が無効') &&
      draftsAfterAdd.count === '0' && draftsAfterAdd.items.length === 0 &&
      draftsAfterAdd.submitDisabled === true,
    `state=${addResult.commentStatusState} text="${addResult.commentStatusText}" ` +
      `count=${draftsAfterAdd.count}`
  );
  await shot(page, '14-add-401-no-draft');

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
  await shot(page, '18-files-tab-t-outside-panel');
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
  // フォームが空であることを保証してから打鍵する
  await page.locator('#functions-tree-panel-host .comment-input').fill('');
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
  await shot(page, '19-files-tab-t-in-panel');

  // 20. textarea 入力中の Esc はフォーカス解除のみ（パネルは開いたまま・本文は残る）、
  //     もう一度 Esc でパネルが閉じること
  await page.keyboard.press('Escape');
  const afterFirstEsc = await page.evaluate(() => {
    const host = document.querySelector('#functions-tree-panel-host');
    const active = host?.shadowRoot?.activeElement;
    return {
      panelOpen: !!host,
      value: host?.shadowRoot?.querySelector('.comment-input')?.value ?? '',
      textareaFocused: active?.classList?.contains('comment-input') ?? false,
    };
  });
  record(
    'escape: first Esc in textarea only blurs (panel stays, draft body kept)',
    afterFirstEsc.panelOpen && afterFirstEsc.value === 't' && !afterFirstEsc.textareaFocused,
    `panelOpen=${afterFirstEsc.panelOpen} value="${afterFirstEsc.value}" ` +
      `textareaFocused=${afterFirstEsc.textareaFocused}`
  );
  await page.keyboard.press('Escape');
  const panelAfterSecondEsc = await page.locator('#functions-tree-panel-host').count();
  record(
    'escape: second Esc closes panel',
    panelAfterSecondEsc === 0,
    `count=${panelAfterSecondEsc}`
  );
  await shot(page, '20-escape-blur-then-close');
} catch (e) {
  record('e2e run', false, e.message);
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log('\n== summary ==');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}: ${r.name}`);
process.exitCode = failed ? 1 : 0;
