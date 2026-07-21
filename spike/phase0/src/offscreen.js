// offscreen document: SW からの指示で同じスパイクを実行して返す
import { runSpike } from './run-spike.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'phase0-run') return;
  runSpike('offscreen').then(sendResponse);
  return true;
});
