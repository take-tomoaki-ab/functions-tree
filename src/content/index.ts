// content script エントリポイント。PR ページの出入りに合わせて UI を注入・除去する。

import { watchPrPages } from './detector';
import { ensureButton, mountUi, unmountUi } from './panel';

watchPrPages({
  onEnter: (pr) => mountUi(pr),
  onLeave: () => unmountUi(),
});

// PR ページ内のタブ切替（turbo）でヘッダーごと DOM が差し替わることがあるため、
// 定期的にボタンの生存確認をする
setInterval(ensureButton, 1000);
