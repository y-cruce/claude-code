import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { patchSplitEsm } from '../scripts/esm-split-patch.mjs';

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-bun-serve-test-'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'cli.js'), 'export {};\n');
  await copyFile(new URL('./fixtures/headless-channel.js', import.meta.url), join(root, 'chunk-channel.js'));
  await patchSplitEsm({ extractDir: root, entryPath: join(root, 'cli.js') });
  await import(pathToFileURL(join(root, 'bun-polyfill.mjs')));
});
after(async () => { await rm(root, { recursive: true, force: true }); });

test('Bun.serve on port 0 reports its real port before returning (plugin tool MCP server)', async () => {
  // Same shape as the plugin tool server: bind, then read .port immediately.
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => new Response(new URL(req.url).pathname) });
  try {
    const port = server.port;
    assert.ok(port > 0, `expected a bound port, got ${port}`);
    assert.equal(server.hostname, '127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${port}/secret/plugin`);
    assert.equal(await res.text(), '/secret/plugin');
  } finally {
    server.stop(true);
  }
});

test('Bun.listen on port 0 reports its real port before returning', async () => {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data(socket, chunk) { socket.write(chunk); socket.end(); } } });
  try {
    const port = server.port;
    assert.ok(port > 0, `expected a bound port, got ${port}`);
    const echoed = await new Promise((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write('ping'));
      let data = '';
      sock.on('data', chunk => { data += chunk; });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    assert.equal(echoed, 'ping');
  } finally {
    server.stop(true);
  }
});
