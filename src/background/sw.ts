// background service worker。
// GitHub API 呼び出しは github-api.ts に委譲する。Phase 3 で tree-sitter 解析がここに載る。

import type { PongResponse, RequestMessage } from '../shared/messages';
import { buildGraphForPr } from './analyzer';
import {
  getFileContent,
  getPrFiles,
  getPrInfo,
  postReviewComment,
  submitReview,
  testAuth,
} from './github-api';

// content script（panel）がレビュー下書きを chrome.storage.session に退避できるようにする。
// session 領域はデフォルトで trusted context（SW / options）専用のため、明示的に開放が必要。
// SW 起動のたびに実行される（設定はブラウザセッション内で保持される）。
void chrome.storage.session.setAccessLevel({
  accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
});

// MV3 の注意: 非同期に応答する場合は listener から true を返して
// sendResponse を後から呼ぶ。false を返すと応答チャネルが即座に閉じる。
chrome.runtime.onMessage.addListener(
  (message: RequestMessage, _sender, sendResponse) => {
    switch (message?.type) {
      case 'PING': {
        const res: PongResponse = { type: 'PONG', receivedAt: Date.now() };
        sendResponse(res);
        return false; // 同期応答
      }
      case 'OPEN_OPTIONS': {
        void chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return false;
      }
      case 'GET_PR_INFO': {
        void getPrInfo(message.pr).then(sendResponse);
        return true; // 非同期応答
      }
      case 'GET_PR_FILES': {
        void getPrFiles(message.pr).then(sendResponse);
        return true;
      }
      case 'GET_FILE_CONTENT': {
        void getFileContent(message.owner, message.repo, message.path, message.ref).then(
          sendResponse
        );
        return true;
      }
      case 'BUILD_GRAPH': {
        void buildGraphForPr(message.pr).then(sendResponse);
        return true;
      }
      case 'POST_REVIEW_COMMENT': {
        void postReviewComment(message.pr, {
          commitId: message.commitId,
          path: message.path,
          line: message.line,
          body: message.body,
        }).then(sendResponse);
        return true;
      }
      case 'SUBMIT_REVIEW': {
        void submitReview(message.pr, {
          commitId: message.commitId,
          comments: message.comments,
        }).then(sendResponse);
        return true;
      }
      case 'TEST_AUTH': {
        void testAuth().then(sendResponse);
        return true;
      }
      default:
        // 未知のメッセージは応答しない（呼び出し側で undefined になる）
        return false;
    }
  }
);
