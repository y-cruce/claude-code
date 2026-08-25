import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { extractBunSEA } from './scripts/bun-sea-extract.mjs';

const version = process.argv[2];
const dir = `.probe/${version}`;
mkdirSync(dir, { recursive: true });
const bin = `${dir}/claude`;
const url = `https://downloads.claude.ai/claude-code-releases/${version}/darwin-arm64/claude`;
execFileSync('curl', ['-sL', '--fail', '--retry', '3', '-o', bin, url], { timeout: 600_000 });
const { modules } = await extractBunSEA(bin);
const names = modules.map(m => m.name);
const hasLegacy = names.some(n => n.includes('src/entrypoints/cli.js'));
console.log(`${version}: ${hasLegacy ? 'LEGACY (src/entrypoints)' : 'FLAT (root cli.js)'}`);
rmSync(dir, { recursive: true, force: true });
