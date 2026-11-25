import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { patchSplitEsm } from '../scripts/esm-split-patch.mjs';

const run = promisify(execFile);
const url = (...parts) => pathToFileURL(join(...parts)).href;

// Same ESM prelude that scripts/esm-split-patch.mjs prepends to bun-polyfill.mjs.
const ESM_PRELUDE = [
  'import{createRequire as __ccCreateRequire}from"module";',
  'import{fileURLToPath as __ccFileURLToPath}from"url";',
  'import{dirname as __ccDirname,join as __ccJoin}from"path";',
  'const require=__ccCreateRequire(import.meta.url);',
  'const __filename=__ccFileURLToPath(import.meta.url);',
  'const __dirname=__ccDirname(__filename);',
  '',
].join('\n');

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-polyfill-upstream-'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'cli.js'), 'export {};\n');
  await copyFile(new URL('./fixtures/headless-channel.js', import.meta.url), join(root, 'chunk-channel.js'));
  await copyFile(new URL('../templates/bun-ink-compat.cjs', import.meta.url), join(root, 'bun-ink-compat.cjs'));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction');
  await patchSplitEsm({ extractDir: root, entryPath: join(root, 'cli.js') });
  await import(url(root, 'bun-polyfill.mjs'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── P0-2: wrapAnsi must not normalize U+2FA1D ──

test('Bun.wrapAnsi preserves U+2FA1D wide emoji placeholder and NFD text without normalizing', () => {
  const NARROW = '\u{F0000}';
  const WIDE = '\u{2FA1D}';
  for (const s of [WIDE, NARROW, `以 ${WIDE} 开头`, `${WIDE}${WIDE} ${NARROW}`]) {
    assert.equal(Bun.wrapAnsi(s, 20, {}), s);
  }
  const wrapped = Bun.wrapAnsi(`${WIDE} alpha beta gamma delta`, 10, {});
  assert.ok(wrapped.includes('\n'), 'line should wrap');
  assert.ok(wrapped.startsWith(WIDE));
  assert.ok(!wrapped.includes('\u{2A600}'));
  const decomposed = 'e\u0301';
  assert.equal(Bun.wrapAnsi(decomposed, 20, {}), decomposed);
});

// ── P0-3: installModuleFastPaths (direct chunk resolver + compile cache) ──

async function makeFastPathPackage(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cc-fast-paths-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pkg = join(dir, 'package');
  await mkdir(join(pkg, 'sub'), { recursive: true });
  const raw = (await readFile(new URL('../templates/bun-polyfill.js', import.meta.url), 'utf8')).replace(/^#![^\n]*\n/, '');
  await Promise.all([
    writeFile(join(pkg, 'package.json'), '{"type":"module"}'),
    writeFile(join(pkg, 'bun-polyfill.mjs'), ESM_PRELUDE + raw),
    writeFile(join(pkg, 'chunk-shared.js'), 'globalThis.__evals=(globalThis.__evals??0)+1;export const tag={};'),
    writeFile(join(pkg, '_0.js'), 'globalThis.__numEvals=(globalThis.__numEvals??0)+1;export const numTag={};'),
    writeFile(join(pkg, 'chunk-a.js'), 'export{tag}from"./chunk-shared.js";export{numTag}from"./_0.js";'),
    writeFile(join(pkg, 'sub', 'chunk-n.js'), 'export{tag}from"../chunk-shared.js";export{numTag}from"../_0.js";'),
    writeFile(join(dir, 'outside.mjs'), 'export const ok=1;'),
  ]);
  return { dir, pkg };
}

test('installModuleFastPaths resolves chunk-*.js and _[0-9]*.js directly with single instance and external fallback', async (t) => {
  const { dir, pkg } = await makeFastPathPackage(t);
  const probe = join(dir, 'probe.mjs');
  await writeFile(probe, `
import { registerHooks, createRequire } from 'node:module';
const seen = [];
registerHooks({ resolve(s, c, n) { if (s.includes('chunk-') || s.includes('_0.js')) seen.push(s); return n(s, c); } });
await import(${JSON.stringify(url(pkg, 'bun-polyfill.mjs'))});
const a = await import(${JSON.stringify(url(pkg, 'chunk-a.js'))});
const nested = await import(${JSON.stringify(url(pkg, 'sub', 'chunk-n.js'))});
const viaRequire = createRequire(${JSON.stringify(join(pkg, 'chunk-a.js'))})('./chunk-shared.js');
const outside = await import(${JSON.stringify(url(pkg, '..', 'outside.mjs'))});
console.log(JSON.stringify({
  reachedNode: seen,
  sameInstance: a.tag === nested.tag && a.tag === viaRequire.tag && a.numTag === nested.numTag,
  evals: globalThis.__evals,
  numEvals: globalThis.__numEvals,
  outside: outside.ok,
}));
`);
  const { stdout } = await run(process.execPath, [probe], {
    cwd: dir,
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
  });
  const r = JSON.parse(stdout);
  assert.deepEqual(r.reachedNode.filter((s) => s.startsWith('.')), []);
  assert.equal(r.sameInstance, true);
  assert.equal(r.evals, 1);
  assert.equal(r.numEvals, 1);
  assert.equal(r.outside, 1);

  // Outside the package, chunk-shaped specifiers must fall back to Node's default resolver.
  await writeFile(join(dir, 'user.mjs'), 'import "./chunk-missing.js";');
  const outsideProbe = join(dir, 'outside-probe.mjs');
  await writeFile(outsideProbe, `await import(${JSON.stringify(url(pkg, 'bun-polyfill.mjs'))});
try { await import(${JSON.stringify(url(dir, 'user.mjs'))}); } catch (e) { console.log(e.code); }`);
  const res = await run(process.execPath, [outsideProbe], {
    cwd: dir,
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
  });
  assert.equal(res.stdout.trim(), 'ERR_MODULE_NOT_FOUND');
});

test('installModuleFastPaths puts compile cache under anthropic-cc/node-compile-cache and respects Node env overrides', async (t) => {
  const { dir, pkg } = await makeFastPathPackage(t);
  const probe = join(dir, 'probe.mjs');
  await writeFile(probe, `await import(${JSON.stringify(url(pkg, 'bun-polyfill.mjs'))});
console.log((await import('node:module')).getCompileCacheDir() ?? 'none');`);
  const home = join(dir, 'home');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, 'local'),
    XDG_CACHE_HOME: join(home, 'xdg'),
  };
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;

  const base = process.platform === 'win32' ? join(home, 'local')
    : process.platform === 'darwin' ? join(home, 'Library', 'Caches')
      : join(home, 'xdg');
  const { stdout } = await run(process.execPath, [probe], { cwd: dir, env });
  assert.ok(stdout.trim().startsWith(join(base, 'anthropic-cc', 'node-compile-cache')), stdout);

  const off = await run(process.execPath, [probe], { cwd: dir, env: { ...env, NODE_DISABLE_COMPILE_CACHE: '1' } });
  assert.equal(off.stdout.trim(), 'none');

  const own = join(dir, 'own-cache');
  const mine = await run(process.execPath, [probe], { cwd: dir, env: { ...env, NODE_COMPILE_CACHE: own } });
  assert.ok(mine.stdout.trim().startsWith(own), mine.stdout);
});

// ── P0-5: Bun.connect + Bun.listen, Bun.hash.xxHash64, Bun.semver, lazy Bun.Image ──

test('Bun.connect exchanges loopback data with Bun.listen via shared wrapSocket', async (t) => {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, chunk) {
        socket.write(Buffer.concat([Buffer.from('echo:'), chunk]));
        socket.end();
      },
    },
  });
  t.after(() => server.stop(true));

  let opened = false;
  let received = '';
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const client = await Bun.connect({
    hostname: '127.0.0.1',
    port: server.port,
    socket: {
      open() { opened = true; },
      data(_socket, chunk) { received += chunk.toString('utf8'); },
      close() { resolveDone(); },
    },
  });

  assert.equal(opened, true, 'open() runs before Bun.connect resolves');
  assert.equal(client.remoteAddress, '127.0.0.1');
  assert.equal(client.remotePort, server.port);
  assert.equal(client.write('hello'), 5);
  await done;
  assert.equal(received, 'echo:hello');
});

test('Bun.hash.xxHash64 returns a BigInt supporting .toString(36) while Bun.hash stays callable', () => {
  assert.equal(typeof Bun.hash('hello'), 'number');
  const h1 = Bun.hash.xxHash64('hello');
  const h2 = Bun.hash.xxHash64('hello');
  const hSeed = Bun.hash.xxHash64('hello', 42);
  assert.equal(typeof h1, 'bigint');
  assert.equal(h1, h2);
  assert.notEqual(h1, hSeed);
  assert.match(h1.toString(36), /^[0-9a-z]+$/);
});

test('Bun.semver propagates invalid version errors instead of swallowing them', () => {
  assert.equal(Bun.semver.order('1.0.0', '2.0.0'), -1);
  assert.equal(Bun.semver.order('2.0.0', '2.0.0'), 0);
  assert.throws(() => Bun.semver.order('not-a-version', '1.0.0'), /Invalid Version/);
  assert.equal(Bun.semver.satisfies('1.2.3', '>=1.0.0'), true);
  assert.equal(Bun.semver.satisfies('not-a-version', '>=1.0.0'), false);
});

test('Bun.Image is exposed as a lazy getter', () => {
  const desc = Object.getOwnPropertyDescriptor(Bun, 'Image');
  assert.equal(typeof desc?.get, 'function');
});
