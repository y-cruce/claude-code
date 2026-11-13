const { transform } = require('sucrase');
const { parse } = require('acorn');

exports.transformSync = (code, loader) => {
  const transforms = loader === 'ts' ? ['typescript']
    : loader === 'tsx' ? ['typescript', 'jsx'] : ['jsx'];
  const output = transform(code, {
    transforms, disableESTransforms: true, production: true,
    jsxRuntime: 'classic', jsxPragma: 'h', jsxFragmentPragma: 'Fragment',
  }).code;
  // The contract validator expects types-only output to contain no comments.
  const comments = [];
  parse(output, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments });
  let result = output;
  for (const { start, end } of comments.reverse()) {
    result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  }
  return result;
};

// Bun.Transpiler({ replMode: true }) for Code Mode's REPL tool. Same envelope
// as Bun: top-level bindings become `var`s so the next call still sees them,
// the body runs in an async arrow (top-level await), and the last expression
// statement is returned as { __proto__: null, value }.
const bindingNames = (node, out) => {
  switch (node?.type) {
    case 'Identifier': out.add(node.name); break;
    case 'ObjectPattern': for (const p of node.properties) bindingNames(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const e of node.elements) bindingNames(e, out); break;
    case 'AssignmentPattern': bindingNames(node.left, out); break;
    case 'RestElement': bindingNames(node.argument, out); break;
  }
};

exports.replTransform = (code) => {
  let ast;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, allowHashBang: true });
  } catch (error) {
    if (error.loc) error.position = { line: error.loc.line, column: error.loc.column + 1, lineText: code.split('\n')[error.loc.line - 1] };
    throw error;
  }
  const text = (node) => code.slice(node.start, node.end);
  const names = new Set();
  const hoisted = [];
  const body = ast.body.map((node, i) => {
    if (node.type === 'VariableDeclaration' && ['var', 'let', 'const'].includes(node.kind)) {
      return node.declarations.map((d) => {
        bindingNames(d.id, names);
        if (d.init) return d.id.type === 'Identifier' ? `${d.id.name} = (${text(d.init)});` : `;(${text(d.id)} = (${text(d.init)}));`;
        return node.kind === 'var' ? '' : `${d.id.name} = void 0;`;
      }).join('\n');
    }
    if (node.type === 'FunctionDeclaration') {
      names.add(node.id.name);
      hoisted.push(`${node.id.name} = ${text(node)};`);
      return '';
    }
    if (node.type === 'ClassDeclaration') {
      names.add(node.id.name);
      return `${node.id.name} = ${text(node)};`;
    }
    if (i === ast.body.length - 1 && node.type === 'ExpressionStatement' && node.directive === undefined) {
      return `return {\n__proto__: null,\nvalue: (${text(node.expression)})\n};`;
    }
    return text(node);
  });
  const vars = names.size > 0 ? `var ${[...names].join(', ')};\n` : '';
  return `${vars}(async () => {\n${[...hoisted, ...body].filter(Boolean).join('\n')}\n})();\n`;
};
