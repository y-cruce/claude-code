import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import { patchHeadlessChannelHandlers, patchSplitEsm } from '../scripts/esm-split-patch.mjs';

const fixture = await readFile(new URL('./fixtures/headless-channel.js', import.meta.url), 'utf8');

test('headless client replacements wire the channel without a turn, independently of minified names', async () => {
  for (const source of [fixture, transformSync(fixture, { minifyIdentifiers: true, minifyWhitespace: true, format: 'esm' }).code]) {
    const patched = patchHeadlessChannelHandlers(source);
    assert.equal(patched.patched, 1);
    const { engine } = await import('data:text/javascript,' + encodeURIComponent(patched.code));
    const state = { mcp: { clients: [] } };
    let changed;
    const queued = [];
    engine(() => state, fn => { changed = fn; }, queued);
    changed();
    assert.deepEqual(queued, []);
    const client = { type: 'connected' };
    state.mcp.clients = [client];
    changed();
    assert.deepEqual(queued, [client]);
    changed();
    assert.deepEqual(queued, [client]);
  }
});

test('missing headless anchors abort both the rewrite and the directory build', async t => {
  assert.throws(() => patchHeadlessChannelHandlers('export {};'), /E9: expected one headless registerChannelHandler/);
  assert.throws(() => patchHeadlessChannelHandlers(fixture.replace('if (clients === previous) return;', '')), /E9: expected one headless MCP clients-change/);
  const root = await mkdtemp(join(tmpdir(), 'cc-channel-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'cli.js'), 'export {};');
  await assert.rejects(patchSplitEsm({ extractDir: root, entryPath: join(root, 'cli.js') }), /E9: expected one headless channel handler patch, patched 0/);
});
