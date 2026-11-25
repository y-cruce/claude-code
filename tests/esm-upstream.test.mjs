import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  bunOnlyImportMeta,
  patchImportMetaDir,
  patchImportMetaRequire,
  patchPluginTestVm,
  patchSplitEsm,
  rewriteNodeFetch,
} from '../scripts/esm-split-patch.mjs';

const loadData = (code) => import(`data:text/javascript,${encodeURIComponent(code)}`);

test('E3: embedded .md, .txt, and .mjs assets load as text without executing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-e3-text-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const markdown = '# Prompt\n你好\n';
  const text = 'Template {{x}}\n';
  const script = 'throw new Error("embedded .mjs asset should not execute");\n';
  await Promise.all([
    writeFile(join(dir, 'prompt.md'), markdown),
    writeFile(join(dir, 'template.txt'), text),
    writeFile(join(dir, 'helper.mjs'), script),
    writeFile(join(dir, 'loader.mjs'), patchImportMetaRequire('export const load = import.meta.require;').code),
  ]);

  const { load } = await import(pathToFileURL(join(dir, 'loader.mjs')).href);
  assert.equal(load(join(dir, 'prompt.md')), markdown);
  assert.equal(load(join(dir, 'template.txt')), text);
  assert.equal(load(join(dir, 'helper.mjs')), script);
});

test('E12: rewriteNodeFetch rewrites module specifiers only and leaves plain strings alone', () => {
  const src = [
    'import nf from "node-fetch";',
    'export { fetch } from "node-fetch";',
    'export * from "node-fetch";',
    'const dyn = () => import("node-fetch");',
    'const cjs = () => require("node-fetch");',
    'const meta = { deps: { "node-fetch": "^3.0.0" }, note: "node-fetch" };',
  ].join('\n');

  const { code, rewritten } = rewriteNodeFetch(src, '../../');
  assert.equal(rewritten, 5);
  assert.equal(code.split('"../../node-fetch-compat.mjs"').length - 1, 5);
  assert.ok(code.includes('deps: { "node-fetch": "^3.0.0" }, note: "node-fetch"'));
  assert.deepEqual(rewriteNodeFetch('const s = "node-fetch";', './'), { code: 'const s = "node-fetch";', rewritten: 0 });
});

test('E12: node-fetch-compat shim forwards to global fetch and ships in extractDir', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-e12-fetch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(join(dir, 'cli.js'), 'export const getFetch = async () => (await import("node-fetch")).default;\n');
  await copyFile(new URL('./fixtures/headless-channel.js', import.meta.url), join(dir, 'chunk-channel.js'));

  const stats = await patchSplitEsm({ extractDir: dir, entryPath: join(dir, 'cli.js') });
  assert.equal(stats.nodeFetch, 1);

  const { getFetch } = await import(pathToFileURL(join(dir, 'cli.js')).href);
  assert.equal(await getFetch(), globalThis.fetch);

  const shim = await import(pathToFileURL(join(dir, 'node-fetch-compat.mjs')).href);
  assert.equal(shim.fetch, globalThis.fetch);
  assert.equal(shim.Headers, globalThis.Headers);
  assert.equal(shim.Request, globalThis.Request);
  assert.equal(shim.Response, globalThis.Response);
  assert.equal(shim.isRedirect(302), true);
  assert.equal(shim.isRedirect(200), false);
  const ferr = new shim.FetchError('boom', 'system', { code: 'ECONNRESET', syscall: 'read' });
  assert.ok(ferr instanceof shim.FetchBaseError);
  assert.equal(ferr.code, 'ECONNRESET');
  assert.equal(ferr.erroredSysCall, 'read');
  assert.ok(new shim.AbortError('cancelled') instanceof shim.FetchBaseError);

  const sample = join(dir, 'sample.txt');
  await writeFile(sample, 'hello');
  assert.equal(await (await shim.blobFrom(sample, 'text/plain')).text(), 'hello');
  assert.equal(await shim.blobFromSync(sample, 'text/plain').text(), 'hello');
  assert.equal((await shim.fileFrom(sample, 'text/plain')).name, 'sample.txt');
  assert.equal(shim.fileFromSync(sample, 'text/plain').name, 'sample.txt');
});

test('P1-7: patchImportMetaDir rewrites .dir/.path on AST and bunOnlyImportMeta blocks unknown properties', async (t) => {
  const src = 'const doc="import.meta.dir import.meta.path";const d=import.meta.dir,p=import.meta.path,u=import.meta.url;';
  const res = patchImportMetaDir(src);
  assert.equal(res.patched, 2);
  assert.equal(res.code, 'const doc="import.meta.dir import.meta.path";const d=import.meta.dirname,p=import.meta.filename,u=import.meta.url;');
  assert.deepEqual(bunOnlyImportMeta(src).sort(), ['dir', 'path']);
  assert.deepEqual(bunOnlyImportMeta(res.code), []);
  assert.deepEqual(bunOnlyImportMeta('if(import.meta.main)run();const e=import.meta.env;').sort(), ['env', 'main']);
  assert.deepEqual(bunOnlyImportMeta('const s="import.meta.main";'), []);
  assert.deepEqual(bunOnlyImportMeta('const x = import.meta.main +;'), ['main']);

  const dir = await mkdtemp(join(tmpdir(), 'cc-meta-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'cli.js'), 'if (import.meta.main) console.log(1);\n');
  await assert.rejects(
    patchSplitEsm({ extractDir: dir, entryPath: join(dir, 'cli.js') }),
    /Bun-only import\.meta properties remain after patching[\s\S]*cli\.js: import\.meta\.main/,
  );
});

test('E5: cyclic require preserves === identity, construct, method this-binding, and safe mid-cycle traps', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-e5-cycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const aPath = join(dir, 'a.js');
  const bPath = join(dir, 'b.js');
  const bRaw = `
const ns = import.meta.require(${JSON.stringify(aPath)});
const BoxRef = ns.Box;
const secretRef = ns.secret;
const objRef = ns.obj;
const fnRef = ns.fn;
export const midCycle = {
  readDuringCycle: secretRef.read,
  hasBox: 'Box' in ns,
  ownKeys: Object.keys(ns),
  desc: Object.getOwnPropertyDescriptor(ns, 'Box'),
  objKeysMid: Object.keys(objRef),
  objSpreadMid: { ...objRef },
  objProtoDescMid: Object.getOwnPropertyDescriptor(objRef, 'prototype'),
};
export function afterCycle() {
  return {
    sameBox: BoxRef === ns.Box,
    sameSecret: secretRef === ns.secret,
    sameObj: objRef === ns.obj,
    sameFn: fnRef === ns.fn,
    box: new BoxRef(99),
    secretValue: secretRef.read(),
    objKeys: Object.keys(objRef),
    objSpread: { ...objRef },
    objProtoDesc: Object.getOwnPropertyDescriptor(objRef, 'prototype'),
    fnResult: fnRef(10),
    num: ns.num,
    hasBox: 'Box' in ns,
    keysIncludeBox: Object.keys(ns).includes('Box'),
  };
}
`;
  await Promise.all([
    writeFile(join(dir, 'package.json'), '{"type":"module"}'),
    writeFile(bPath, patchImportMetaRequire(bRaw).code),
    writeFile(aPath, `
import { midCycle, afterCycle } from './b.js';
export class Box { constructor(v) { this.v = v; } }
class Secret {
  #v;
  constructor(v) { this.#v = v; }
  read() { return this.#v; }
}
export const secret = new Secret(42);
export const obj = { a: 1, b: 2 };
export const fn = (x) => x + 1;
export const num = 7;
export { midCycle, afterCycle };
`),
  ]);

  const mod = await import(pathToFileURL(aPath).href);
  assert.deepEqual(mod.midCycle, {
    readDuringCycle: undefined,
    hasBox: false,
    ownKeys: [],
    desc: undefined,
    objKeysMid: [],
    objSpreadMid: {},
    objProtoDescMid: undefined,
  });

  const post = mod.afterCycle();
  assert.equal(post.sameBox, true);
  assert.equal(post.sameSecret, true);
  assert.equal(post.sameObj, true);
  assert.equal(post.sameFn, true);
  assert.ok(post.box instanceof mod.Box);
  assert.equal(post.box.v, 99);
  assert.equal(post.secretValue, 42);
  assert.deepEqual(post.objKeys, ['a', 'b']);
  assert.deepEqual(post.objSpread, { a: 1, b: 2 });
  assert.equal(post.objProtoDesc, undefined);
  assert.equal(post.fnResult, 11);
  assert.equal(post.num, 7);
  assert.equal(post.hasBox, true);
  assert.equal(post.keysIncludeBox, true);
});

test('E7: patchPluginTestVm handles arbitrary env expressions and fails build on unmatched marker', async (t) => {
  const FLAGS = '--experimental-vm-modules --disable-warning=ExperimentalWarning';
  const stubs = 'const spawn=(c,a,o)=>o;const pick=(e)=>({PATH:e.PATH});const host=()=>({PATH:"/bin"});';

  for (const [label, code, arg, expected] of [
    [
      'call expression',
      `${stubs}export const run=()=>spawn("node",["plugin","test","--file","a","b"],{env:pick(host())});`,
      undefined,
      { PATH: '/bin', NODE_OPTIONS: FLAGS },
    ],
    [
      'object of spreads',
      `${stubs}export const run=()=>spawn("node",["plugin","test","--file","a","b"],{env:{...pick(host()),TERM:"dumb"}});`,
      undefined,
      { PATH: '/bin', TERM: 'dumb', NODE_OPTIONS: FLAGS },
    ],
    [
      'shorthand property',
      `${stubs}export const run=(env)=>spawn("node",["plugin","test","--file","a","b"],{env});`,
      { A: '1' },
      { A: '1', NODE_OPTIONS: FLAGS },
    ],
  ]) {
    const out = patchPluginTestVm(code);
    assert.equal(out.patched, 1, label);
    assert.equal(patchPluginTestVm(out.code).patched, 0, `${label} idempotent`);
    const { run } = await loadData(out.code);
    assert.deepEqual(run(arg).env, expected, label);
  }

  const settled = `${stubs}spawn("node",["plugin","test","--file","a","b"],{env:{...pick(host()),NODE_OPTIONS:"--x"}});`;
  assert.deepEqual(patchPluginTestVm(settled), { code: settled, patched: 0 });

  const dir = await mkdtemp(join(tmpdir(), 'cc-e7-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'cli.js'), 'export const argv = ["plugin", "test", "--file"];\n');
  await assert.rejects(
    patchSplitEsm({ extractDir: dir, entryPath: join(dir, 'cli.js') }),
    /E7: plugin test child argv found in 1 module\(s\), but no spawn site was patched/,
  );
});
