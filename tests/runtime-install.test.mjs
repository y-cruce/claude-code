import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { buildMainPackage } from '../scripts/build-main-package.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cc-runtime-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ANTHROPIC_CC_DATA_DIR: join(root, 'data') };
  const versions = join(env.ANTHROPIC_CC_DATA_DIR, 'versions');
  async function main(version, label = version, type = 'split-esm') {
    const dir = join(root, `main-${version}-${label}`);
    await buildMainPackage({ version, layout: type, outputDir: dir });
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json')));
    pkg.dependencies = { 'fixture-dep': '1.0.0' };
    pkg.optionalDependencies = {};
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    const platform = join(dir, 'node_modules', `@cometix/anthropic-cc-${process.platform}-${process.arch}`);
    mkdirSync(platform, { recursive: true });
    writeFileSync(join(platform, 'package.json'), JSON.stringify({ name: '@cometix/platform', version }));
    writeFileSync(join(platform, 'chunk-lazy.js'), type === 'split-esm'
      ? `export default ${JSON.stringify(label)};` : `module.exports = ${JSON.stringify(label)};`);
    writeFileSync(join(platform, 'cli.js'), `
(async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(process.argv[1]);
  const dep = req('fixture-dep');
  console.log(JSON.stringify({ label: (await import('./chunk-lazy.js')).default, dep, cli: process.argv[1], nodeOptions: process.env.NODE_OPTIONS }));
  if (process.argv.includes('--wait')) setInterval(() => {}, 1000);
})();`);
    // Both dependencies are hoisted. The copied tree must resolve without npm.
    for (const [name, pkg, code] of [
      ['fixture-dep', { dependencies: { 'fixture-transitive': '1.0.0' } }, "module.exports = require('fixture-transitive');"],
      ['fixture-transitive', {}, "module.exports = 'copied';"],
    ]) {
      const dep = join(dir, 'node_modules', name);
      mkdirSync(dep, { recursive: true });
      writeFileSync(join(dep, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.cjs', ...pkg }));
      writeFileSync(join(dep, 'index.cjs'), code);
    }
    return dir;
  }
  async function install(dir) {
    const saved = process.env.ANTHROPIC_CC_DATA_DIR;
    process.env.ANTHROPIC_CC_DATA_DIR = env.ANTHROPIC_CC_DATA_DIR;
    try {
      const runtime = await import(pathToFileURL(join(dir, 'runtime.mjs')).href);
      return await runtime.install();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_CC_DATA_DIR;
      else process.env.ANTHROPIC_CC_DATA_DIR = saved;
    }
  }
  function run(dir, file = 'cli.js', args = []) {
    const result = spawnSync(process.execPath, [join(dir, file), ...args], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, JSON.stringify(result));
    return result.stdout.trim();
  }
  function tree(version) {
    const dir = join(versions, version);
    return join(dir, JSON.parse(readFileSync(join(dir, 'current.json'))).build);
  }
  return { root, env, versions, main, install, run, tree };
}

test('launcher selects its own version and recovers a missing tree with copied hoisted dependencies', async t => {
  const f = await fixture(t);
  const a = await f.main('1.0.0');
  const b = await f.main('2.0.0');
  await f.install(a);
  await f.install(b);
  assert.equal(JSON.parse(f.run(a)).label, '1.0.0');
  rmSync(f.tree('2.0.0'), { recursive: true });
  const launches = await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, [join(b, 'cli.js')], { env: f.env, timeout: 30000 })));
  const result = JSON.parse(launches[0].stdout);
  assert.equal(JSON.parse(launches[1].stdout).cli, result.cli);
  assert.equal(result.label, '2.0.0');
  assert.equal(result.dep, 'copied');
  assert.equal(result.nodeOptions, process.env.NODE_OPTIONS);
  rmSync(join(b, 'node_modules'), { recursive: true });
  assert.equal(createRequire(join(f.tree('2.0.0'), 'cli.js'))('fixture-dep'), 'copied');
});

test('failed install leaves the published tree intact and removes the partial copy', async t => {
  const f = await fixture(t);
  const main = await f.main('1.0.0');
  await f.install(main);
  const oldTree = f.tree('1.0.0');
  rmSync(join(main, 'node_modules', 'fixture-transitive'), { recursive: true });
  await assert.rejects(f.install(main), /Missing runtime dependency/);
  assert.equal(f.tree('1.0.0'), oldTree);
  assert.deepEqual(readdirSync(join(f.versions, '1.0.0')).filter(name => name.startsWith('.tmp-')), []);
  assert.equal(createRequire(join(oldTree, 'cli.js'))('fixture-dep'), 'copied');
});

test('pruning retains a directly launched live build, current and previous versions, then removes stale builds', async t => {
  const f = await fixture(t);
  const a = await f.main('1.0.0');
  await f.install(a);
  const oldTree = f.tree('1.0.0');
  const child = spawn(process.execPath, [join(oldTree, 'cli.js'), '--wait'], { env: { ...f.env, ANTHROPIC_CC_DATA_DIR: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  assert.ok(existsSync(join(oldTree, '.pids', String(child.pid))));
  const rerelease = await f.main('1.0.0', 'rebuild');
  // A same-version re-release whose postinstall was skipped has a new build ID.
  assert.equal(JSON.parse(f.run(rerelease)).label, 'rebuild');
  assert.notEqual(f.tree('1.0.0'), oldTree);
  assert.match(readFileSync(join(oldTree, 'chunk-lazy.js'), 'utf8'), /1\.0\.0/);
  for (const version of ['2.0.0', '3.0.0']) await f.install(await f.main(version));
  assert.ok(existsSync(oldTree));
  assert.ok(existsSync(f.tree('2.0.0')));
  assert.ok(existsSync(f.tree('3.0.0')));
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  await f.install(await f.main('4.0.0'));
  assert.equal(existsSync(join(f.versions, '1.0.0')), false);
  assert.equal(existsSync(join(f.versions, '2.0.0')), false);
  assert.ok(existsSync(f.tree('3.0.0')));
  assert.ok(existsSync(f.tree('4.0.0')));
});

test('launcher and isolated entry also support the single-CJS layout', async t => {
  const f = await fixture(t);
  const main = await f.main('1.0.0', 'cjs', 'single-cjs');
  assert.equal(JSON.parse(f.run(main)).label, 'cjs');
});
