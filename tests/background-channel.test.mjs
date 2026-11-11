import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import { patchBackgroundChannelDefaults, patchSplitEsm } from '../scripts/esm-split-patch.mjs';

const fixture = await readFile(new URL('./fixtures/headless-channel.js', import.meta.url), 'utf8');
const start = fixture.indexOf('export function startChannels');

test('background channel defaults merge environment entries, independently of minified names', async t => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of ['CLAUDE_CODE_SESSION_KIND', 'CC_FORK_CHANNELS']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const cases = [
    { kind: 'bg', env: 'plugin:one@market, server:two\nplugin:three@market', expected: ['plugin:one@market', 'server:two', 'plugin:three@market'] },
    { kind: 'bg', existing: ['server:existing'], expected: ['server:existing'] },
    { env: 'plugin:one@market', existing: ['server:existing'], expected: ['server:existing'] },
    { kind: 'bg', env: ',server:two plugin:one@market,server:two,', existing: ['plugin:one@market', 'server:existing', 'plugin:one@market'], expected: ['plugin:one@market', 'server:existing', 'server:two'] },
  ];
  for (const source of [fixture, transformSync(fixture, { minifyIdentifiers: true, minifyWhitespace: true, format: 'esm' }).code]) {
    const patched = patchBackgroundChannelDefaults(source);
    const { startChannels } = await import('data:text/javascript,' + encodeURIComponent(patched.code));
    for (const row of cases) {
      if (row.kind === undefined) delete process.env.CLAUDE_CODE_SESSION_KIND;
      else process.env.CLAUDE_CODE_SESSION_KIND = row.kind;
      if (row.env === undefined) delete process.env.CC_FORK_CHANNELS;
      else process.env.CC_FORK_CHANNELS = row.env;
      const calls = [];
      const result = startChannels({ channels: row.existing }, (entries, flag) => {
        assert.equal(flag, '--channels');
        return entries;
      }, entries => calls.push(entries));
      assert.deepEqual(result.allowed, row.expected);
      assert.deepEqual(calls, [row.expected]);
    }
    assert.equal(patched.patched, 1);
  }
});

test('missing, ambiguous or immutable background channel anchors abort the rewrite and build', async t => {
  assert.throws(() => patchBackgroundChannelDefaults('export {};'), /E10: expected one background channel startup anchor, found 0/);
  const startup = fixture.slice(start);
  assert.throws(() => patchBackgroundChannelDefaults(startup + startup.replace('function startChannels', 'function second')), /E10: expected one background channel startup anchor, found 2/);
  for (const kind of ['const', 'var']) {
    assert.throws(() => patchBackgroundChannelDefaults(startup.replace('let { channels', `${kind} { channels`)), /E10: channel list must be a let binding/);
  }
  const root = await mkdtemp(join(tmpdir(), 'cc-bg-channel-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'cli.js'), fixture.slice(0, start));
  await assert.rejects(patchSplitEsm({ extractDir: root, entryPath: join(root, 'cli.js') }), /E10: expected one background channel startup patch, patched 0/);
  await writeFile(join(root, 'chunk-one.js'), startup);
  await writeFile(join(root, 'chunk-two.js'), startup);
  await assert.rejects(patchSplitEsm({ extractDir: root, entryPath: join(root, 'cli.js') }), /E10: expected one background channel startup patch, patched 2/);
});
