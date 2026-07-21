// tree-sitter によるパース・抽出ロジック（実行コンテキスト非依存）
// Node / MV3 service worker / offscreen document から同じコードを使う
import { Parser, Language, Query } from 'web-tree-sitter';

// runtimeWasm: web-tree-sitter.wasm の URL（省略時は Emscripten の既定解決 = Node 用）
// langWasm: tree-sitter-typescript.wasm の URL・パス・Uint8Array
export async function initParser({ runtimeWasm, langWasm }) {
  await Parser.init(
    runtimeWasm ? { locateFile: () => runtimeWasm } : undefined
  );
  const language = await Language.load(langWasm);
  const parser = new Parser();
  parser.setLanguage(language);
  return { parser, language };
}

const FUNCTIONS_QUERY = `
(function_declaration name: (identifier) @name) @func
(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression)]) @func
(method_definition name: (property_identifier) @name) @func
`;

const IMPORTS_QUERY = `
(import_statement source: (string (string_fragment) @source)) @import
`;

function collectCalls(node) {
  const calls = [];
  const cursor = node.walk();
  const visit = () => {
    if (cursor.nodeType === 'call_expression') {
      const fn = cursor.currentNode.childForFieldName('function');
      if (fn) calls.push({ callee: fn.text, line: fn.startPosition.row + 1 });
    }
    if (cursor.gotoFirstChild()) {
      do {
        visit();
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };
  visit();
  return calls;
}

function collectImportedNames(importNode) {
  const names = [];
  const clause = importNode.namedChildren.find(
    (c) => c.type === 'import_clause'
  );
  if (!clause) return names;
  const walk = (n) => {
    if (n.type === 'identifier') names.push(n.text);
    for (const child of n.namedChildren) walk(child);
  };
  walk(clause);
  return names;
}

export function analyze(language, parser, sourceCode) {
  const tree = parser.parse(sourceCode);

  const funcQuery = new Query(language, FUNCTIONS_QUERY);
  const functions = funcQuery.matches(tree.rootNode).map((m) => {
    const funcNode = m.captures.find((c) => c.name === 'func').node;
    const nameNode = m.captures.find((c) => c.name === 'name').node;
    return {
      name: nameNode.text,
      kind: funcNode.type,
      startLine: funcNode.startPosition.row + 1,
      endLine: funcNode.endPosition.row + 1,
      calls: collectCalls(funcNode),
    };
  });

  const importQuery = new Query(language, IMPORTS_QUERY);
  const imports = importQuery.matches(tree.rootNode).map((m) => {
    const importNode = m.captures.find((c) => c.name === 'import').node;
    const sourceNode = m.captures.find((c) => c.name === 'source').node;
    return {
      source: sourceNode.text,
      names: collectImportedNames(importNode),
      line: importNode.startPosition.row + 1,
    };
  });

  return { functions, imports };
}
