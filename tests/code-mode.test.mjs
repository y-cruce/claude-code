import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { moduleContents } from '../scripts/bun-sea-extract.mjs';

const { replTransform } = createRequire(import.meta.url)('../templates/bun-transpiler-compat.cjs');

test('replMode envelope keeps bindings across calls and returns the last expression', async () => {
  const context = vm.createContext({ setTimeout, fetchPair: async () => ({ a: 1, b: [2, { c: 3 }] }) });
  const run = async (code) => {
    const value = (await vm.runInContext(replTransform(code), context))?.value;
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  };
  const calls = [
    ['1+1', 2],
    ['const x = 40; let y; var z = 1; x + 1', 41],
    ['x + z', 41],
    ['const { a, b: [first, { c = 0, d = 9 }], ...rest } = await fetchPair(); [a, first, c, d, rest]', [1, 2, 3, 9, {}]],
    ['const [p, , ...more] = [1, 2, 3, 4]; ({ p, more })', { p: 1, more: [3, 4] }],
    ['[a, first, c, d, p, more.length]', [1, 2, 3, 9, 1, 2]],
    ['const t = twice(4)\nfunction twice(n) { return n * 2 }\nt', 8],
    ['class Box { constructor(v) { this.v = v } }\nnew Box(twice(x)).v', 80],
    ['await new Promise((r) => setTimeout(r, 1)); x', 40],
    ['const done = 1', undefined],
  ];
  for (const [code, expected] of calls) assert.deepEqual(await run(code), expected, code);
  assert.match(replTransform('const { a } = f()\nlet [b] = g()\na + b'), /^var a, b;\n\(async \(\) => \{/);
});

test('UTF-16LE text assets are written as UTF-8', () => {
  const text = '# Title — ×2\n';
  const asset = moduleContents({ encoding: 'utf8', contents: Buffer.from(text, 'utf16le') });
  assert.equal(asset.toString('utf8'), text);
  const utf8 = Buffer.from(text, 'utf8');
  assert.equal(moduleContents({ encoding: 'utf8', contents: utf8 }), utf8);
  assert.equal(moduleContents({ encoding: 'binary', contents: Buffer.from(text, 'utf16le') }).length, text.length * 2);
});
