// background service worker。
// GitHub API 呼び出しは github-api.ts に委譲する。Phase 3 で tree-sitter 解析がここに載る。

import type { PongResponse, RequestMessage } from '../shared/messages';
import { buildGraphForPr } from './analyzer';
import {
  getFileContent,
  getPrFiles,
  getPrInfo,
  postReviewComment,
  testAuth,
} from './github-api';

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
