// background service worker。
// Phase 1 では content script からのメッセージに応答する骨組みのみ。
// Phase 2 以降で GitHub API 呼び出し、Phase 3 で tree-sitter 解析がここに載る。

import type { RequestMessage, PongResponse } from '../shared/messages';

chrome.runtime.onMessage.addListener(
  (message: RequestMessage, _sender, sendResponse) => {
    switch (message?.type) {
      case 'PING': {
        const res: PongResponse = { type: 'PONG', receivedAt: Date.now() };
        sendResponse(res);
        return false; // 同期応答
      }
      default:
        // 未知のメッセージは応答しない（呼び出し側で undefined になる）
        return false;
    }
  }
);
