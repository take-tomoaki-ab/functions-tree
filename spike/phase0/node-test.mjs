// Node 上でのサニティチェック（実環境検証の代替ではない）
import { fileURLToPath } from 'node:url';
import { initParser, analyze } from './src/analyzer.js';
import { SAMPLE_TS } from './src/sample-code.js';

const langWasm = fileURLToPath(
  new URL(
    './node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm',
    import.meta.url
  )
);

const { parser, language } = await initParser({ langWasm });
const result = analyze(language, parser, SAMPLE_TS);
console.log(JSON.stringify(result, null, 2));
