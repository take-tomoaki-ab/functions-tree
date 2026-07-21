// MV3 background service worker: SW 上でスパイクを実行し、
// 続けて offscreen document でも同じテストを実行して結果を集約する
import { runSpike } from './run-spike.js';

async function sendMessageWithRetry(message, retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function runOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification:
        'phase0 spike: verify tree-sitter WASM in a DOM-having context',
    });
    return await sendMessageWithRetry({ type: 'phase0-run' });
  } catch (e) {
    return {
      context: 'offscreen',
      ok: false,
      error: { name: e?.name, message: e?.message ?? String(e), stack: e?.stack },
    };
  }
}

async function main() {
  console.log('[phase0] start');
  const sw = await runSpike('service_worker');
  console.log('[phase0] SW result:', JSON.stringify(sw));
  const offscreen = await runOffscreen();
  console.log('[phase0] offscreen result:', JSON.stringify(offscreen));
  await chrome.storage.local.set({
    phase0: { sw, offscreen, finishedAt: new Date().toISOString() },
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL('result.html') });
}

chrome.runtime.onInstalled.addListener(() => {
  main();
});
chrome.runtime.onStartup.addListener(() => {
  main();
});
