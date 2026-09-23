import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { patchBuiltinHooksModuleShipping, patchHooksWorker, patchImportMetaDir, patchSplitEsm } from '../scripts/esm-split-patch.mjs';

const host = `
const urlOf = () => ({ HOOKS_WORKER_URL: '/tmp/hooks-worker.js' }).HOOKS_WORKER_URL;
const optionsOf = stamp => ({ name: 'hooks', workerData: { stamp } });
export function spawn(stamp) { return new Worker(urlOf(), optionsOf(stamp)); }
export function cores() { if (typeof Worker > 'u') return 1; return new Worker('blob:cores'); }
export function prime() { if (typeof Worker > 'u') return 'sync'; return new Worker('forge/prime.worker.js'); }
`;
let root;
let workerURL;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-hooks-test-'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'cli.js'), host);
  const workerDir = join(root, 'src/plugins/functionHooks/hooks-worker');
  await mkdir(workerDir, { recursive: true });
  const worker = join(workerDir, 'hooks-worker.js');
  await writeFile(worker, `
import { workerData } from 'node:worker_threads';
import { SyntheticModule } from 'node:vm';
self.onmessage = ({ data }) => {
  if (data === 'throw') throw new Error('uncaught fixture');
  if (data === 'exit') process.exit(0);
  if (data === 'exit7') process.exit(7);
  if (data.port) { data.port.postMessage(workerData.marker); data.port.close(); }
  self.postMessage({ self: self === globalThis, marker: workerData.marker,
    vm: typeof SyntheticModule, flags: process.execArgv,
    text: Bun.Transpiler ? new Bun.Transpiler({loader:'ts'}).transformSync('export const x: number = 1') : null });
};`);
  const stats = await patchSplitEsm({ extractDir: root, entryPath: join(root, 'cli.js') });
  assert.equal(stats.hooksWorkers, 1);
  await import(pathToFileURL(join(root, 'bun-polyfill.mjs')));
  workerURL = pathToFileURL(worker);
});
after(async () => { await rm(root, { recursive: true, force: true }); });

function eventOf(worker, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} event within 5s`)), 5000);
    worker.addEventListener(type, event => { clearTimeout(timer); resolve(event); }, { once: true });
  });
}

test('only hooks constructor changes; forge guards and fallback results remain unchanged', async () => {
  const patched = patchHooksWorker(host);
  assert.equal(patched.patched, 1);
  assert.equal(patched.code.replace('globalThis.__ccHooksWorker', 'Worker'), host);
  assert.equal(typeof globalThis.Worker, 'undefined');
  const original = await import('data:text/javascript,' + encodeURIComponent(host));
  const restored = await import(pathToFileURL(join(root, 'cli.js')));
  assert.equal(restored.cores(), original.cores());
  assert.equal(restored.prime(), original.prime());
});

test('built-in hooks receive a real module path and shipped content on Node', async () => {
  const source = `
import { join } from 'node:path';
const standalone = () => false;
const ship = (module, scan, folder) => ({ module, scan, folder });
const hooks = (folder, module, factory) => standalone() ? ship(module, factory(), folder) : { module: module, folder: folder };
export const register = () => {
  const entry = hooks(import.meta.dir, 'built-in', () => 42);
  return { path: join(entry.folder, 'register.ts'), scan: entry.scan };
};`;
  const directory = patchImportMetaDir(source);
  const shipped = patchBuiltinHooksModuleShipping(directory.code);
  assert.equal(directory.patched, 1);
  assert.equal(shipped.patched, 1);
  const file = join(root, 'builtin-hooks.js');
  await writeFile(file, shipped.code);
  const { register } = await import(pathToFileURL(file));
  assert.deepEqual(register(), { path: join(await realpath(root), 'register.ts'), scan: 42 });
});

test('entry exists but no matching hooks constructor fails the build', async () => {
  await writeFile(join(root, 'cli.js'), 'export const changed = true;');
  await assert.rejects(patchSplitEsm({ extractDir: root, entryPath: join(root, 'cli.js') }), /expected one hooks Worker/);
});

test('messages, workerData, port transfer, self, VM flag and TS transpiler work in the worker', async () => {
  const worker = new globalThis.__ccHooksWorker(workerURL, { workerData: { marker: 37 }, execArgv: ['--no-warnings'] });
  try {
    worker.unref().ref();
    const channel = new MessageChannel();
    const port = new Promise(resolve => channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); });
    const response = eventOf(worker, 'message');
    worker.postMessage({ port: channel.port2 }, [channel.port2]);
    const event = await response;
    assert.equal(event.target, worker);
    assert.equal(await port, 37);
    assert.equal(event.data.marker, 37);
    assert.equal(event.data.self, true);
    assert.equal(event.data.vm, 'function');
    assert.deepEqual(event.data.flags, ['--no-warnings', '--experimental-vm-modules']);
    assert.match(event.data.text, /export const x\s*=\s*1/);
  } finally { await worker.terminate(); }
});

for (const [name, command, expected] of [
  ['missing entry', null, /Cannot find module/],
  ['uncaught exception', 'throw', /uncaught fixture/],
  ['unexpected zero exit', 'exit', /exited unexpectedly \(code 0\)/],
  ['unexpected nonzero exit', 'exit7', /exited unexpectedly \(code 7\)/],
]) {
  test(`${name} produces exactly one error event without hanging`, async () => {
    const worker = new globalThis.__ccHooksWorker(command ? workerURL : pathToFileURL(join(root, 'missing.js')), { workerData: {} });
    let errors = 0;
    worker.addEventListener('error', () => errors++);
    try {
      const failed = eventOf(worker, 'error');
      if (command) worker.postMessage(command);
      const event = await failed;
      assert(event instanceof ErrorEvent);
      assert.match(event.message, expected);
      await worker.terminate();
      assert.equal(errors, 1);
    } finally { await worker.terminate(); }
  });
}

test('intentional terminate does not report an unexpected exit', async () => {
  const worker = new globalThis.__ccHooksWorker(workerURL, { workerData: {} });
  let errors = 0;
  worker.onerror = () => errors++;
  const response = eventOf(worker, 'message');
  worker.postMessage({});
  await response;
  await worker.terminate();
  assert.equal(errors, 0);
});

test('VM flag is not duplicated when supplied explicitly', async () => {
  const worker = new globalThis.__ccHooksWorker(workerURL, { workerData: {}, execArgv: ['--experimental-vm-modules'] });
  try {
    const response = eventOf(worker, 'message');
    worker.postMessage({});
    assert.equal((await response).data.flags.filter(flag => flag === '--experimental-vm-modules').length, 1);
  } finally { await worker.terminate(); }
});

test('transpiler bundle has no external imports and preserves hooks/contract conventions', async () => {
  const result = await build({
    entryPoints: [new URL('../templates/bun-transpiler-compat.cjs', import.meta.url).pathname],
    outfile: join(root, 'check.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', minify: true, metafile: true,
  });
  for (const output of Object.values(result.metafile.outputs)) assert.deepEqual(output.imports, []);
  const { transformSync } = createRequire(import.meta.url)(join(root, 'check.cjs'));
  assert.equal(transformSync('/** types */\nexport interface X {x: string}', 'ts').trim(), '');
  const code = transformSync('import type {X} from "claude-code"; export const x: string = "/* keep */";', 'ts');
  assert.match(code, /\/\* keep \*\//);
  assert.doesNotMatch(code, /import type/);
  const jsx = transformSync('export const view = <><Box>hi</Box></>;', 'tsx');
  assert.match(jsx, /h\(Fragment/);
  assert.match(jsx, /h\(Box/);
  assert.doesNotMatch(jsx, /require\(|jsx-runtime/);
});
