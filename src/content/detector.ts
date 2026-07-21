// PR ページの検出と、GitHub の SPA 遷移（turbo）への追従。

import type { PrRef } from '../shared/messages';

// /{owner}/{repo}/pull/{number} とその配下 (/files, /commits, ...) にマッチ。
// owner/repo に予約パス (orgs, settings 等) が来ることはあるが、
// pull/{number} まで揃う URL は実質 PR ページのみなので厳密な除外はしない。
const PR_PATH_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;

/** URL (pathname) から PR リファレンスを抽出。PR ページでなければ null */
export function parsePrUrl(url: string | URL): PrRef | null {
  const pathname = typeof url === 'string' ? new URL(url, location.origin).pathname : url.pathname;
  const m = PR_PATH_RE.exec(pathname);
  if (!m) return null;
  return { owner: m[1], repo: m[2], pr: Number(m[3]) };
}

export interface DetectorCallbacks {
  /** PR ページに入った（または PR が切り替わった）とき */
  onEnter(pr: PrRef): void;
  /** PR ページから離れたとき */
  onLeave(): void;
}

/**
 * 現在 URL を監視し、PR ページへの出入りをコールバックする。
 *
 * GitHub は turbo による SPA 遷移を行うため、以下を併用する:
 * - turbo:load / turbo:render: ページ本体の DOM が差し替わった後に発火
 * - popstate: 戻る/進む
 * - フォールバックの低頻度ポーリング: content script の isolated world からは
 *   ページ側の history.pushState をフックできないため、イベントを取りこぼしても
 *   最終的に追従できる保険
 */
export function watchPrPages(callbacks: DetectorCallbacks): void {
  let currentKey: string | null = null;

  const check = () => {
    const pr = parsePrUrl(new URL(location.href));
    const key = pr ? `${pr.owner}/${pr.repo}#${pr.pr}` : null;
    if (key === currentKey) return;
    if (currentKey !== null) callbacks.onLeave();
    currentKey = key;
    if (pr) callbacks.onEnter(pr);
  };

  document.addEventListener('turbo:load', check);
  document.addEventListener('turbo:render', check);
  window.addEventListener('popstate', check);
  setInterval(check, 1000);

  check();
}
