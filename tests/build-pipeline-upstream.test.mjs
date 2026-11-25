import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readMagic, extractBunSEA, moduleContents } from '../scripts/bun-sea-extract.mjs';
import {
  isZstdFramed,
  collectBunApis,
  collectPolyfillApis,
  scanBunApis,
  collectCompressedAssets,
  formatCoverageReport,
} from '../scripts/bun-api-coverage.mjs';

test('bun-sea-extract readMagic reads 4-byte headers and rejects unsupported binaries', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-sea-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const cases = [
    ['macho', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x01])],
    ['pe', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])],
    ['elf', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02])],
    ['unknown', Buffer.from('NOTABIN!')],
  ];

  for (const [name, buf] of cases) {
    const file = join(dir, name);
    writeFileSync(file, buf);
    const head = readMagic(file);
    assert.equal(head.length, 4);
    assert.deepEqual(head, buf.subarray(0, 4));
  }

  await assert.rejects(extractBunSEA(join(dir, 'unknown')), /Unsupported binary format/);
});

test('bun-sea-extract moduleContents converts UTF-16LE utf8-tagged text and preserves others', () => {
  const text = 'Hello — 世界';
  const utf16 = Buffer.from(text, 'utf16le');
  assert.equal(moduleContents({ encoding: 'utf8', contents: utf16 }).toString('utf8'), text);

  // Plain UTF-8 (no NUL) stays untouched
  const utf8 = Buffer.from(text, 'utf8');
  assert.equal(moduleContents({ encoding: 'utf8', contents: utf8 }), utf8);

  // Non-utf8 encoding stays untouched even with NUL bytes
  assert.equal(moduleContents({ encoding: 'binary', contents: utf16 }), utf16);

  // Odd length or decoded NUL stays untouched
  const odd = Buffer.from([0x41, 0x00, 0x42]);
  assert.equal(moduleContents({ encoding: 'utf8', contents: odd }), odd);
  const embeddedNul = Buffer.from('a\0b', 'utf16le');
  assert.equal(moduleContents({ encoding: 'utf8', contents: embeddedNul }), embeddedNul);
});

test('extract-worker.mjs syntax, CLI usage, and UTF-16LE moduleContents integration', () => {
  const workerPath = join(import.meta.dirname, '..', 'scripts', 'extract-worker.mjs');
  const check = spawnSync(process.execPath, ['--check', workerPath], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);

  const usage = spawnSync(process.execPath, [workerPath], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage: node extract-worker\.mjs/);

  const src = readFileSync(workerPath, 'utf8');
  assert.match(src, /moduleContents/);
});

test('bun-api-coverage collects Bun APIs, polyfill surface, zstd assets, and formats report', async (t) => {
  const code = [
    'const a = Bun.spawn(["ls"]);',
    'const b = Bun.missingUnguarded();',
    'const c = Bun.missingGuarded?.();',
    'const d = typeof Bun.typeofGuarded;',
    'try { Bun.tryGuarded(); } catch {}',
    'const e = Bun.hash.nonExistentMethod("x");',
    'const f = Bun["file"]("/tmp/x");',
    'const ignored1 = foo.Bun.nope;',
    'const ignored2 = "Bun.inString";',
  ].join('\n');

  const apis = collectBunApis(code);
  assert.equal(apis.has('nope'), false);
  assert.equal(apis.has('inString'), false);
  assert.equal(apis.get('spawn').guarded, false);
  assert.equal(apis.get('file').guarded, false);
  assert.equal(apis.get('missingUnguarded').guarded, false);
  assert.equal(apis.get('missingGuarded').guarded, true);
  assert.equal(apis.get('typeofGuarded').guarded, true);
  assert.equal(apis.get('tryGuarded').guarded, true);
  assert.ok(apis.get('hash').members.has('nonExistentMethod'));

  const poly = collectPolyfillApis('globalThis.Bun = { a: 1, b() {} }; Bun.c = 3;');
  assert.deepEqual([...poly].sort(), ['a', 'b', 'c']);

  assert.equal(isZstdFramed(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])), true);
  assert.equal(isZstdFramed(Buffer.from('plain text')), false);

  const dir = mkdtempSync(join(tmpdir(), 'cc-cov-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'chunk-a.js'), code);
  writeFileSync(join(dir, 'prompt.md'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x00]));
  writeFileSync(join(dir, 'readme.txt'), 'hello');

  const report = await scanBunApis(dir, ['chunk-a.js']);
  assert.deepEqual(report.fatal, ['missingUnguarded']);
  assert.ok(report.missing.includes('missingGuarded'));
  assert.ok(report.shallow.some((s) => s.api === 'hash' && s.members.includes('nonExistentMethod')));

  const compressed = await collectCompressedAssets(dir, ['prompt.md', 'readme.txt']);
  assert.deepEqual(compressed, ['prompt.md']);

  const text = formatCoverageReport(report, compressed);
  assert.match(text, /Unpolyfilled and unguarded: missingUnguarded/);
  assert.match(text, /Bun\.hash is polyfilled but \.nonExistentMethod is missing/);
  assert.match(text, /zstd-framed assets: 1/);

  const cli = spawnSync(
    process.execPath,
    [join(import.meta.dirname, '..', 'scripts', 'bun-api-coverage.mjs'), dir],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Bun APIs called:/);
  assert.match(cli.stdout, /zstd-framed assets: 1/);
});
