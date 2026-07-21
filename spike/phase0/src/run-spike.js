// SW / offscreen 共通のスパイク実行ロジック
import { initParser, analyze } from './analyzer.js';
import { SAMPLE_TS } from './sample-code.js';

export async function runSpike(contextName) {
  const report = {
    context: contextName,
    ok: false,
    hasDocument: typeof document !== 'undefined',
    hasXHR: typeof XMLHttpRequest !== 'undefined',
  };
  try {
    const t0 = performance.now();
    const { parser, language } = await initParser({
      runtimeWasm: chrome.runtime.getURL('wasm/web-tree-sitter.wasm'),
      langWasm: chrome.runtime.getURL('wasm/tree-sitter-typescript.wasm'),
    });
    report.initMs = Math.round(performance.now() - t0);
    const t1 = performance.now();
    report.result = analyze(language, parser, SAMPLE_TS);
    report.parseMs = Math.round(performance.now() - t1);
    report.ok = true;
  } catch (e) {
    report.error = {
      name: e?.name,
      message: e?.message ?? String(e),
      stack: e?.stack,
    };
  }
  return report;
}
