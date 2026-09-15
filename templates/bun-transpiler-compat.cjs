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
