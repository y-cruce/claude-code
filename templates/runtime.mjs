import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const packageDir = dirname(fileURLToPath(import.meta.url));
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

export function versionsRoot() {
  const dataHome = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(resolve(process.env.ANTHROPIC_CC_DATA_DIR || join(dataHome, 'anthropic-cc')), 'versions');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// Selection, registration and pruning share a lock so a selected tree cannot
// disappear between reading current.json and recording the launching process.
async function locked(root, action) {
  const locks = join(root, '.locks');
  mkdirSync(locks, { recursive: true });
  const id = randomUUID();
  const file = join(locks, id + '.json');
  const temp = join(locks, '.' + id);
  function publish(ticket) {
    writeFileSync(temp, JSON.stringify({ pid: process.pid, ticket }));
    renameSync(temp, file);
  }
  function contenders() {
    const entries = [];
    for (const name of readdirSync(locks)) {
      if (!name.endsWith('.json')) continue;
      const path = join(locks, name);
      let entry;
      try { entry = readJson(path); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (alive(entry.pid)) entries.push({ ...entry, id: name.slice(0, -5) });
      else rmSync(path, { force: true });
    }
    return entries;
  }
  // Publish intent before choosing a ticket. Unique records make stale-owner
  // cleanup safe even when several installers recover a dead lock together.
  publish(0);
  try {
    const ticket = Math.max(0, ...contenders().map(entry => entry.ticket)) + 1;
    publish(ticket);
    while (contenders().some(entry => entry.id !== id &&
      (entry.ticket === 0 || entry.ticket < ticket || (entry.ticket === ticket && entry.id < id)))) {
      await setTimeout(50);
    }
    return action();
  } finally {
    rmSync(file, { force: true });
    rmSync(temp, { force: true });
  }
}

function platformKey() {
  let musl = false;
  if (process.platform === 'linux') {
    try { musl = process.report.getReport().header.glibcVersionRuntime === undefined; }
    catch {}
  }
  return `${process.platform}-${process.arch}${musl ? '-musl' : ''}`;
}

function dependencyDir(name, from) {
  const req = createRequire(join(from, 'package.json'));
  for (const base of req.resolve.paths(name) || []) {
    const dir = join(base, name);
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  throw new Error(`Missing runtime dependency: ${name}`);
}

// npm may hoist transitive dependencies outside the main package. Resolve
// each dependency from its source, then preserve that resolution in the copy.
function copyDependency(name, from, nodeModules, ancestors = new Map()) {
  const src = dependencyDir(name, from);
  if (ancestors.get(name) === src) return;
  const dest = join(nodeModules, name);
  cpSync(src, dest, { recursive: true, dereference: true, filter: file => file !== join(src, 'node_modules') });
  const pkg = readJson(join(src, 'package.json'));
  const chain = new Map(ancestors).set(name, src);
  for (const dep of Object.keys(pkg.dependencies || {})) {
    if (dep in (pkg.optionalDependencies || {})) continue;
    copyDependency(dep, src, join(dest, 'node_modules'), chain);
  }
  for (const dep of Object.keys(pkg.optionalDependencies || {})) {
    try { dependencyDir(dep, src); } catch { continue; }
    copyDependency(dep, src, join(dest, 'node_modules'), chain);
  }
  if (name === 'node-pty' && process.platform !== 'win32') {
    const prebuilds = join(dest, 'prebuilds');
    if (existsSync(prebuilds)) {
      for (const platform of readdirSync(prebuilds)) {
        const helper = join(prebuilds, platform, 'spawn-helper');
        if (existsSync(helper)) chmodSync(helper, 0o755);
      }
    }
  }
}

function selected(versionDir, source) {
  try {
    const pointer = readJson(join(versionDir, 'current.json'));
    if (source !== undefined && pointer.source !== source) return null;
    const build = pointer.build;
    const tree = join(versionDir, build);
    return existsSync(join(tree, 'cli.js')) ? tree : null;
  } catch { return null; }
}

function register(tree) {
  mkdirSync(join(tree, '.pids'), { recursive: true });
  writeFileSync(join(tree, '.pids', String(process.pid)), '');
}

function inUse(tree) {
  const markers = join(tree, '.pids');
  if (!existsSync(markers)) return false;
  let live = false;
  for (const pid of readdirSync(markers)) {
    if (/^[1-9]\d*$/.test(pid) && alive(Number(pid))) live = true;
    else rmSync(join(markers, pid), { force: true });
  }
  return live;
}

function prune(root, currentVersion, previousVersion) {
  const versions = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name);
  for (const version of versions) {
    const dir = join(root, version);
    const active = selected(dir);
    for (const build of readdirSync(dir, { withFileTypes: true })) {
      if (!build.isDirectory() || build.name.startsWith('.')) continue;
      const tree = join(dir, build.name);
      if (inUse(tree)) continue;
      if ((version === currentVersion || version === previousVersion) && tree === active) continue;
      rmSync(tree, { recursive: true, force: true });
    }
    if (version !== currentVersion && version !== previousVersion &&
        !readdirSync(dir, { withFileTypes: true }).some(entry => entry.isDirectory())) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function populate(mainDir, versionDir) {
  const pkg = readJson(join(mainDir, 'package.json'));
  const platform = dependencyDir(`@cometix/anthropic-cc-${platformKey()}`, mainDir);
  mkdirSync(versionDir, { recursive: true });
  const temp = mkdtempSync(join(versionDir, '.tmp-'));
  try {
    cpSync(platform, temp, { recursive: true, dereference: true });
    // The runtime retains the main package's identity/type for updater and CJS.
    writeFileSync(join(temp, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    copyFileSync(join(mainDir, 'bun-ink-compat.cjs'), join(temp, 'bun-ink-compat.cjs'));
    for (const name of Object.keys(pkg.dependencies || {})) {
      copyDependency(name, mainDir, join(temp, 'node_modules'));
    }
    for (const name of Object.keys(pkg.optionalDependencies || {})) {
      if (name.startsWith('@cometix/anthropic-cc-')) continue;
      try { dependencyDir(name, mainDir); } catch { continue; }
      copyDependency(name, mainDir, join(temp, 'node_modules'));
    }
    renameSync(join(temp, 'cli.js'), join(temp, 'runtime-entry.js'));
    // Register in the entry itself before importing any other tree file. This
    // covers direct background launches without an inherited preload setting.
    const prelude = pkg.type === 'module'
      ? `import { mkdirSync, writeFileSync } from 'node:fs';\nimport { dirname, join } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst tree = dirname(fileURLToPath(import.meta.url));\n`
      : `const { mkdirSync, writeFileSync } = require('node:fs');\nconst { join } = require('node:path');\nconst tree = __dirname;\n`;
    writeFileSync(join(temp, 'cli.js'), `#!/usr/bin/env node\n${prelude}const markers = join(tree, '.pids');\nmkdirSync(markers, { recursive: true });\nwriteFileSync(join(markers, String(process.pid)), '');\nimport('./runtime-entry.js').catch(error => { console.error(error); process.exitCode = 1; });\n`);
    chmodSync(join(temp, 'cli.js'), 0o755);
    const build = `build-${Date.now()}-${temp.split('.tmp-').pop()}`;
    const tree = join(versionDir, build);
    renameSync(temp, tree);
    const pointer = join(versionDir, `.current-${process.pid}.json`);
    writeFileSync(pointer, JSON.stringify({ build, source: pkg.runtimeBuild }) + '\n');
    renameSync(pointer, join(versionDir, 'current.json'));
    return tree;
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

function installVersion(root) {
  const { version } = readJson(join(packageDir, 'package.json'));
  const tree = populate(packageDir, join(root, version));
  let history = {};
  try { history = readJson(join(root, 'installed.json')); } catch {}
  const previous = history.current === version ? history.previous : history.current;
  const temp = join(root, `.installed-${process.pid}.json`);
  writeFileSync(temp, JSON.stringify({ current: version, previous }) + '\n');
  renameSync(temp, join(root, 'installed.json'));
  prune(root, version, previous);
  return tree;
}

export async function install() {
  const root = versionsRoot();
  return locked(root, () => installVersion(root));
}

export async function launch() {
  const root = versionsRoot();
  const { version, runtimeBuild } = readJson(join(packageDir, 'package.json'));
  const tree = await locked(root, () => {
    const tree = selected(join(root, version), runtimeBuild) || installVersion(root);
    register(tree);
    return tree;
  });
  // Background CLI launches use this immutable path, including after npm upgrades.
  process.argv[1] = join(tree, 'cli.js');
  await import(pathToFileURL(process.argv[1]).href);
}

