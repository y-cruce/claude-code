import { readFile, writeFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { astPatch } from './node-compat-patch.mjs';
import { BASE_PATH_POSIX, BASE_PATH_WINDOWS } from './bun-sea-extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────
//  Split-ESM patching (v2.1.242+)
//
//  From 2.1.242 the SEA no longer embeds one CJS bundle. It ships a small
//  ESM entry plus ~1400 chunk-*.js modules that import each other through
//  absolute Bun virtual-filesystem paths (/$bunfs/root/...).
//
//  Node can run that layout as-is once the paths point at real files, so
//  this module rewrites the whole extract directory instead of patching a
//  single cli.js.
// ──────────────────────────────────────────────

// macOS/Linux builds embed /$bunfs/root/, Windows builds embed B:/~BUN/root/
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const BUNFS_ROOTS = [BASE_PATH_POSIX, BASE_PATH_WINDOWS].map((b) => `${b}root/`);
const ROOT_ALT = BUNFS_ROOTS.map(escapeRe).join('|');

// import/export specifiers: from"...", import"...", import("...")
const SPECIFIER_RE = new RegExp(`(from|import)(\\s*\\(?\\s*)"(?:${ROOT_ALT})([^"]+)"`, 'g');
// whatever is left is a runtime path, not a module specifier
const LITERAL_RE = new RegExp(`"(?:${ROOT_ALT})([^"]*)"`, 'g');

const ESM_PRELUDE = [
  'import{createRequire as __ccCreateRequire}from"module";',
  'import{fileURLToPath as __ccFileURLToPath}from"url";',
  'import{dirname as __ccDirname,join as __ccJoin}from"path";',
  'const require=__ccCreateRequire(import.meta.url);',
  'const __filename=__ccFileURLToPath(import.meta.url);',
  'const __dirname=__ccDirname(__filename);',
  '',
].join('\n');

// Bun resolved /$bunfs/root/ against the embedded filesystem. On Node the
// same files sit next to cli.js, and native modules live under vendor/.
const ESM_HELPERS = [
  '',
  'globalThis.__ccNodeRequire=require;',
  'globalThis.__ccAsset=(name)=>name?__ccJoin(__dirname,name):__dirname;',
  'globalThis.__ccVendorNode=(name)=>{',
  '  const base=name.replace(/\\.node$/,"");',
  '  const p=__ccJoin(__dirname,"vendor",base,process.arch+"-"+process.platform,name);',
  '  return require("fs").existsSync(p)?p:__ccJoin(__dirname,name);',
  '};',
  '',
].join('\n');

// Files whose AST is worth walking — parsing all 1400 chunks costs minutes
// and only these markers can match a P-patch.
const AST_MARKERS = ['CLAUDE_CODE_ENTRYPOINT', 'HttpsProxyAgent', '_cc_bin', 'claude-cli-internal'];

async function listJsFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await listJsFiles(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// First statement of the module — everything before it is the comment header
function firstStatementStart(code) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  return ast.body.length > 0 ? ast.body[0].start : code.length;
}

// "./" for root-level files, "../../../../" for nested entrypoints
function prefixFor(filePath, root) {
  const depth = relative(root, dirname(filePath)).split(sep).filter(Boolean).length;
  return depth === 0 ? './' : '../'.repeat(depth);
}

export function rewriteBunfsPaths(code, prefix) {
  let specifiers = 0;
  let literals = 0;

  code = code.replace(SPECIFIER_RE, (_m, kw, gap, target) => {
    specifiers++;
    return `${kw}${gap}"${prefix}${target}"`;
  });

  code = code.replace(LITERAL_RE, (_m, target) => {
    literals++;
    return target.endsWith('.node')
      ? `globalThis.__ccVendorNode(${JSON.stringify(target)})`
      : `globalThis.__ccAsset(${JSON.stringify(target)})`;
  });

  return { code, specifiers, literals };
}

// Bun exposes import.meta.require; Node needs createRequire.
// Bun's require also returns file CONTENT for text-loader assets (.md/.txt,
// used since 2.1.246 for embedded prompts), so those go through readFileSync.
// Object.assign keeps require.resolve/cache available on the wrapper.
export function patchImportMetaRequire(code) {
  if (!code.includes('import.meta.require')) return { code, patched: false };
  const inject = 'import{createRequire as __ccMakeRequire}from"module";'
    + 'import{readFileSync as __ccReadAsset}from"fs";'
    + 'const __ccRawRequire=__ccMakeRequire(import.meta.url);'
    + 'const __ccRequire=Object.assign((id)=>/\\.(md|txt)$/.test(id)'
    + '?__ccReadAsset(id,"utf8"):__ccRawRequire(id),__ccRawRequire);';
  const at = firstStatementStart(code);
  code = code.slice(0, at) + inject + code.slice(at);
  code = code.replaceAll('import.meta.require', '__ccRequire');
  return { code, patched: true };
}

export async function patchSplitEsm({ extractDir, entryPath }) {
  const files = await listJsFiles(extractDir);
  const stats = { files: files.length, specifiers: 0, literals: 0, metaRequire: 0, ast: {} };

  for (const file of files) {
    let code = await readFile(file, 'utf8');
    const before = code;

    const rewritten = rewriteBunfsPaths(code, prefixFor(file, extractDir));
    code = rewritten.code;
    stats.specifiers += rewritten.specifiers;
    stats.literals += rewritten.literals;

    const meta = patchImportMetaRequire(code);
    code = meta.code;
    if (meta.patched) stats.metaRequire++;

    if (AST_MARKERS.some((m) => code.includes(m))) {
      const result = astPatch(code, 'module');
      code = result.code;
      if (result.replacementCount > 0) {
        // the single-bundle path validates after patching; do the same here
        try {
          acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
        } catch (e) {
          throw new Error(`post-patch AST validation failed for ${file}: ${e.message}`);
        }
        // counted in files touched, so the numbers stay comparable
        for (const [k, v] of Object.entries(result.stats)) {
          if (v === true || (typeof v === 'number' && v > 0)) stats.ast[k] = (stats.ast[k] ?? 0) + 1;
        }
      }
    } else {
      // P9 rebrand still has to reach every chunk that names the npm package
      const rebranded = code.replaceAll('@anthropic-ai/claude-code', '@cometix/anthropic-cc');
      if (rebranded !== code) {
        code = rebranded;
        stats.ast.p9 = (stats.ast.p9 ?? 0) + 1;
      }
    }

    if (code !== before) await writeFile(file, code);
  }

  // Bun polyfill, ESM-wrapped, next to the entry
  let polyfill = readFileSync(join(__dirname, '..', 'templates', 'bun-polyfill.js'), 'utf8');
  polyfill = polyfill.replace(/^#![^\n]*\n/, '');
  await writeFile(join(extractDir, 'bun-polyfill.mjs'), ESM_PRELUDE + polyfill + ESM_HELPERS);

  // The polyfill has to be the entry's first import so that globalThis.Bun
  // exists before any chunk body runs. Worker entrypoints need it too.
  const workerEntries = files.filter((f) => f.endsWith('hooks-worker.js'));
  for (const entry of [entryPath, ...workerEntries]) {
    let code = await readFile(entry, 'utf8');
    const at = firstStatementStart(code);
    const importPath = `${prefixFor(entry, extractDir)}bun-polyfill.mjs`;
    code = code.slice(0, at) + `import"${importPath}";` + code.slice(at);
    if (entry === entryPath && !code.startsWith('#!')) code = '#!/usr/bin/env node\n' + code;
    await writeFile(entry, code);
  }
  stats.polyfillEntries = 1 + workerEntries.length;

  return stats;
}
