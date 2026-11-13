import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleContents } from '../scripts/bun-sea-extract.mjs';

test('UTF-16LE text assets are written as UTF-8', () => {
  const text = '# Title — ×2\n';
  const asset = moduleContents({ encoding: 'utf8', contents: Buffer.from(text, 'utf16le') });
  assert.equal(asset.toString('utf8'), text);
  const utf8 = Buffer.from(text, 'utf8');
  assert.equal(moduleContents({ encoding: 'utf8', contents: utf8 }), utf8);
  assert.equal(moduleContents({ encoding: 'binary', contents: Buffer.from(text, 'utf16le') }).length, text.length * 2);
});
