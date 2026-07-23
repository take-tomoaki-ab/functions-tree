// シンタックスハイライト抽出（background/highlight.ts + 各言語の highlight 設定）のテスト。
// analyzeFile が各関数に付与する highlights が、sourceText の正しい位置・種別を指すことを
// 3 言語のインラインソースで検証する。
// 実行前に pretest（esbuild）が dist-test/analyzer-core.mjs を生成する。

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';

import { createAnalyzer } from '../dist-test/analyzer-core.mjs';

const nm = join(import.meta.dirname, '..', 'node_modules');

/** @type {import('../src/background/analyzer-core').Analyzer} */
let analyzer;

before(async () => {
  analyzer = await createAnalyzer({
    grammars: {
      typescript: join(nm, 'tree-sitter-typescript', 'tree-sitter-typescript.wasm'),
      tsx: join(nm, 'tree-sitter-typescript', 'tree-sitter-tsx.wasm'),
      go: join(nm, 'tree-sitter-go', 'tree-sitter-go.wasm'),
      python: join(nm, 'tree-sitter-python', 'tree-sitter-python.wasm'),
    },
  });
});

/** 指定種別のトークンが指す sourceText 上の文字列一覧 */
function textsOf(fn, kind) {
  return fn.highlights
    .filter(([, , k]) => k === kind)
    .map(([s, e]) => fn.sourceText.slice(s, e));
}

/** トークン列の不変条件: 昇順・重なりなし・sourceText の範囲内 */
function assertWellFormed(fn) {
  let pos = 0;
  for (const [start, end] of fn.highlights) {
    assert.ok(start >= pos, `トークンが逆順または重複: ${start} < ${pos}`);
    assert.ok(end > start, 'トークンが空');
    assert.ok(end <= fn.sourceText.length, 'トークンが sourceText の範囲外');
    pos = end;
  }
}

describe('TypeScript のハイライト', () => {
  const src = `// ファイルコメント
export async function greet(name: string): Promise<string> {
  // 挨拶する
  const msg = \`hello \${name}\`;
  if (name !== 'x') return msg.toUpperCase();
  return trim(msg) + 42 + null;
}
`;

  test('キーワード / 文字列 / コメント / 数値 / 型 / 関数名を塗り分ける', () => {
    const fn = analyzer.analyzeFile('a.ts', src).functions[0];
    assertWellFormed(fn);

    const keywords = textsOf(fn, 'keyword');
    for (const kw of ['async', 'function', 'const', 'if', 'return']) {
      assert.ok(keywords.includes(kw), `keyword に ${kw} がない: ${keywords}`);
    }
    // sourceText（function_declaration）の範囲外にある export は含まれない
    assert.ok(!keywords.includes('export'));
    // ファイル外のトークン（関数より前のコメント）は含まれない
    assert.deepEqual(textsOf(fn, 'comment'), ['// 挨拶する']);
    // 文字列は引用符・内容の両方が塗られる（template_string の補間は除く）
    const strings = textsOf(fn, 'string').join('');
    assert.ok(strings.includes('hello '));
    assert.ok(!strings.includes('${name}'), '補間の中身は string で塗らない');
    assert.deepEqual(textsOf(fn, 'number'), ['42']);
    assert.deepEqual(textsOf(fn, 'constant'), ['null']);
    // 型: 注釈の predefined_type と type_identifier
    const types = textsOf(fn, 'type');
    assert.ok(types.includes('string'));
    assert.ok(types.includes('Promise'));
    // 関数: 定義名 + 呼び出し名（メソッド呼び出しはメソッド名のみ）
    const functions = textsOf(fn, 'function');
    assert.deepEqual(functions, ['greet', 'toUpperCase', 'trim']);
    // 識別子（変数）は無装飾
    assert.ok(!functions.includes('msg'));
  });

  test('GraphNode に highlightTokens が乗る（tsx 文法でも動く）', () => {
    const a = analyzer.analyzeFile('a.tsx', 'const f = () => <div>{1}</div>;\n');
    assert.equal(a.functions[0].name, 'f');
    assert.ok(a.functions[0].highlights.length > 0);
  });
});

describe('Go のハイライト', () => {
  const src = `package main

func Greet(name string) (string, error) {
	// 挨拶する
	s := fmt.Sprintf("hello %s", name)
	if len(s) > 3 {
		return raw(s), nil
	}
	return s, nil
}
`;

  test('キーワード / 文字列 / 数値 / 型 / 関数名を塗り分ける', () => {
    const fn = analyzer.analyzeFile('main.go', src).functions[0];
    assertWellFormed(fn);

    const keywords = textsOf(fn, 'keyword');
    for (const kw of ['func', 'if', 'return']) {
      assert.ok(keywords.includes(kw), `keyword に ${kw} がない: ${keywords}`);
    }
    assert.deepEqual(textsOf(fn, 'comment'), ['// 挨拶する']);
    // 文字列は引用符ごと 1 トークン
    assert.deepEqual(textsOf(fn, 'string'), ['"hello %s"']);
    assert.deepEqual(textsOf(fn, 'number'), ['3']);
    assert.deepEqual(textsOf(fn, 'constant'), ['nil', 'nil']);
    const types = textsOf(fn, 'type');
    assert.ok(types.includes('string'));
    assert.ok(types.includes('error'));
    assert.deepEqual(textsOf(fn, 'function'), ['Greet', 'Sprintf', 'len', 'raw']);
  });
});

describe('Python のハイライト', () => {
  const src = `def greet(name: str, n: int = 42) -> str:
    # 挨拶する
    msg = f"hello {name}"
    if n > 0 and name != 'x':
        return msg.upper()
    return trim(msg) or None
`;

  test('キーワード / 文字列 / 数値 / 型 / 関数名を塗り分ける', () => {
    const fn = analyzer.analyzeFile('a.py', src).functions[0];
    assertWellFormed(fn);

    const keywords = textsOf(fn, 'keyword');
    for (const kw of ['def', 'if', 'and', 'or', 'return']) {
      assert.ok(keywords.includes(kw), `keyword に ${kw} がない: ${keywords}`);
    }
    assert.deepEqual(textsOf(fn, 'comment'), ['# 挨拶する']);
    // f-string は引用符・内容が塗られ、補間 {name} は塗られない
    const strings = textsOf(fn, 'string').join('');
    assert.ok(strings.includes('f"'));
    assert.ok(strings.includes('hello '));
    assert.ok(!strings.includes('{name}'));
    assert.deepEqual(textsOf(fn, 'number'), ['42', '0']);
    assert.deepEqual(textsOf(fn, 'constant'), ['None']);
    // 型注釈は type ノードごと塗られる
    const types = textsOf(fn, 'type');
    assert.deepEqual(types, ['str', 'int', 'str']);
    assert.deepEqual(textsOf(fn, 'function'), ['greet', 'upper', 'trim']);
  });

  test('デコレータ付き関数はデコレータ行を含む範囲でトークンを持つ', () => {
    const a = analyzer.analyzeFile(
      'b.py',
      '@wrap\ndef f():\n    return 1\n'
    );
    const fn = a.functions[0];
    assertWellFormed(fn);
    // sourceText はデコレータ行から始まり、def キーワードの位置もズレない
    const kwToken = fn.highlights.find(([, , k]) => k === 'keyword');
    assert.equal(fn.sourceText.slice(kwToken[0], kwToken[1]), 'def');
  });
});
