import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { buildMainPackage } from '../scripts/build-main-package.mjs';
import { buildPlatformPackage } from '../scripts/build-platform-package.mjs';
import { patchSplitEsm } from '../scripts/esm-split-patch.mjs';

test('installed image helper reads clipboard images with only declared runtime dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cc-image-runtime-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  const extract = join(root, 'extract');
  await buildMainPackage({ version: '1.0.0', layout: 'split-esm', outputDir: main });
  const pkg = JSON.parse(await readFile(join(main, 'package.json'), 'utf8'));
  // Build a minimal install from the generated native dependency declaration.
  // Other CLI dependencies are unrelated to image processing.
  pkg.dependencies = {};
  const nativeName = `@img/sharp-${process.platform}-${process.arch}`;
  assert.ok(pkg.optionalDependencies[nativeName]);
  pkg.optionalDependencies = { [nativeName]: pkg.optionalDependencies[nativeName] };
  await writeFile(join(main, 'package.json'), JSON.stringify(pkg));
  const req = createRequire(import.meta.url);
  const nativeDir = join(main, 'node_modules', nativeName);
  await mkdir(nativeDir, { recursive: true });
  const nativeSource = req.resolve(`${nativeName}/package`);
  // Let the real installer copy the native package and its transitive libvips.
  await cp(dirname(nativeSource), nativeDir, { recursive: true });
  const nativePkg = JSON.parse(await readFile(nativeSource, 'utf8'));
  for (const name of Object.keys(nativePkg.optionalDependencies || {})) {
    const source = req.resolve(`${name}/package`);
    await cp(dirname(source), join(main, 'node_modules', name), { recursive: true });
  }

  const png = await req('sharp')({ create: { width: 3, height: 2, channels: 4, background: '#ff0000' } }).png().toBuffer();
  const preload = join(root, 'clipboard.cjs');
  await writeFile(preload, `
const cp = require('node:child_process');
const original = cp.execFileSync;
cp.execFileSync = (file, args, options) => {
  if (file !== '/usr/bin/osascript') return original(file, args, options);
  return args.at(-1).includes('base64EncodedStringWithOptions') ? ${JSON.stringify(png.toString('base64'))} : 'true';
};`);
  await mkdir(extract);
  await writeFile(join(extract, 'cli.js'), `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./bun-sharp-compat.cjs');
const Image = require('./bun-image-compat.cjs');
// The mock supplies image data without changing the machine's clipboard.
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
let image;
try {
  if (!Image.hasClipboardImage()) throw new Error('clipboard image not detected');
  image = Image.fromClipboard();
} finally {
  Object.defineProperty(process, 'platform', platform);
}
const output = await image.resize(1, 1).png().toBuffer();
const metadata = await new Bun.Image(output).metadata();
let disposed = false;
{
  using resource = { [Symbol.dispose]() { disposed = true; } };
}
await (async () => {
  await using resource = { async [Symbol.asyncDispose]() {} };
})();
console.log(JSON.stringify({ width: metadata.width, height: metadata.height, disposed }));`);
  await patchSplitEsm({ extractDir: extract, entryPath: join(extract, 'cli.js') });
  await buildPlatformPackage({
    platform: `${process.platform}-${process.arch}`, version: pkg.version, layout: 'split-esm', extractDir: extract,
    outputDir: join(main, 'node_modules', `@cometix/anthropic-cc-${process.platform}-${process.arch}`),
  });
  const result = spawnSync(process.execPath, ['--require', preload, join(main, 'cli.js')], {
    env: { ...process.env, NODE_PATH: '', ANTHROPIC_CC_DATA_DIR: join(root, 'data') },
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { width: 1, height: 1, disposed: true });
});
