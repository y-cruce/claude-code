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

// E5: since 2.1.250 chunks call import.meta.require on SIBLING CHUNKS, often
// at top level and inside import cycles. Node's require(esm) throws
// ERR_REQUIRE_CYCLE_MODULE while the target's graph is still evaluating, but
// returns the namespace from cache once the target has finished. A bare
// static import per required chunk forces exactly that: the target evaluates
// before this module's body, and the original require becomes a cache hit.
// Requires inside functions are left alone on purpose — they run after
// startup (or conditionally), where plain require(esm) already works.
const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function isChunkRequire(node) {
  if (node.type !== 'CallExpression' ||
      node.callee?.type !== 'MemberExpression' ||
      node.callee.object?.type !== 'MetaProperty' ||
      node.callee.property?.name !== 'require' ||
      node.arguments?.length !== 1) return null;
  // after E2 the argument reads globalThis.__ccAsset("chunk-x.js")
  const arg = node.arguments[0];
  if (arg?.type !== 'CallExpression' ||
      arg.callee?.type !== 'MemberExpression' ||
      arg.callee.object?.name !== 'globalThis' ||
      arg.callee.property?.name !== '__ccAsset' ||
      arg.arguments?.[0]?.type !== 'Literal') return null;
  const target = arg.arguments[0].value;
  return typeof target === 'string' && target.endsWith('.js') ? target : null;
}

export function hoistTopLevelChunkRequires(code, prefix) {
  if (!code.includes('import.meta.require')) return { code, hoisted: 0 };
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const targets = new Set();

  (function visit(node, inFn) {
    if (!inFn) {
      const target = isChunkRequire(node);
      if (target) targets.add(target);
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item.type === 'string') visit(item, inFn || FN_TYPES.has(item.type));
        }
      } else if (child && typeof child.type === 'string') {
        visit(child, inFn || FN_TYPES.has(child.type));
      }
    }
  })(ast, false);

  if (targets.size === 0) return { code, hoisted: 0 };
  const imports = [...targets].map((t) => `import${JSON.stringify(prefix + t)};`).join('');
  const at = ast.body.length > 0 ? ast.body[0].start : code.length;
  return { code: code.slice(0, at) + imports + code.slice(at), hoisted: targets.size };
}

// Bun exposes import.meta.require; Node needs createRequire.
// Bun's require also returns file CONTENT for text-loader assets (.md/.txt,
// used since 2.1.246 for embedded prompts), so those go through readFileSync.
// Object.assign keeps require.resolve/cache available on the wrapper.
//
// Since 2.1.250 chunks also require() OTHER CHUNKS at top level (hundreds of
// sites). Node's require(esm) refuses modules whose graph is still mid-
// evaluation in an import cycle (ERR_REQUIRE_CYCLE_MODULE) where Bun
// re-enters evaluation and returns the namespace. Node cannot re-enter, so:
// - require in a cycle → lazy NAMESPACE proxy (re-requires on first access,
//   which succeeds once the cycle has finished evaluating);
// - property read on that proxy while the cycle is STILL evaluating (the
//   top-level `var X=require(chunk).Prop` pattern) → lazy VALUE proxy,
//   cached per (module, prop) so every grabber gets the identical object
//   and === comparisons between them keep working.
export function patchImportMetaRequire(code) {
  if (!code.includes('import.meta.require')) return { code, patched: false };
  const inject = 'import{createRequire as __ccMakeRequire}from"module";'
    + 'import{readFileSync as __ccReadAsset}from"fs";'
    + 'const __ccRawRequire=__ccMakeRequire(import.meta.url);'
    + 'globalThis.__ccLazyVals??=new Map();'
    + 'const __ccLazyVal=(id,p)=>{const k=id+"\\0"+p,m=globalThis.__ccLazyVals;'
    + 'if(m.has(k))return m.get(k);'
    + 'let v,ok=!1;const g=()=>{if(!ok){v=__ccRawRequire(id)[p];ok=!0}return v};'
    // target must be callable (grabbed values include functions) and free of
    // non-configurable own props (proxy invariants) — an arrow fn is both
    + 'const px=new Proxy(()=>{},{get:(_,q)=>g()?.[q],'
    + 'apply:(_,th,a)=>Reflect.apply(g(),th,a),'
    + 'has:(_,q)=>{const t=g();return t!=null&&q in t},'
    + 'ownKeys:()=>{const t=g();return t==null?[]:Reflect.ownKeys(t)},'
    + 'getOwnPropertyDescriptor:(_,q)=>{const t=g(),'
    + 'd=t==null?void 0:Reflect.getOwnPropertyDescriptor(t,q);'
    + 'if(d)d.configurable=!0;return d},'
    + 'getPrototypeOf:()=>{const t=g();return t==null?null:Reflect.getPrototypeOf(Object(t))}});'
    + 'm.set(k,px);return px};'
    + 'const __ccLazyNs=(id)=>{let n=null;const r=()=>n??(n=__ccRawRequire(id));'
    + 'return new Proxy({},{'
    + 'get:(_,p)=>{const m=globalThis.__ccLazyVals;'
    + 'if(typeof p==="string"&&m.has(id+"\\0"+p))return m.get(id+"\\0"+p);'
    + 'try{return r()[p]}catch(e){'
    + 'if(e&&e.code==="ERR_REQUIRE_CYCLE_MODULE"){'
    + 'if(typeof p!=="string"||p==="then")return;return __ccLazyVal(id,p)}'
    + 'throw e}},'
    + 'has:(_,p)=>p in r(),'
    + 'ownKeys:()=>Reflect.ownKeys(r()),'
    + 'getOwnPropertyDescriptor:(_,p)=>{const d=Reflect.getOwnPropertyDescriptor(r(),p);'
    + 'if(d)d.configurable=!0;return d},'
    + 'getPrototypeOf:()=>Reflect.getPrototypeOf(r())})};'
    + 'const __ccRequire=Object.assign((id)=>{'
    + 'if(/\\.(md|txt)$/.test(id))return __ccReadAsset(id,"utf8");'
    + 'try{return __ccRawRequire(id)}catch(e){'
    + 'if(e&&e.code==="ERR_REQUIRE_CYCLE_MODULE")return __ccLazyNs(id);'
    + 'throw e}},__ccRawRequire);';
  const at = firstStatementStart(code);
  code = code.slice(0, at) + inject + code.slice(at);
  code = code.replaceAll('import.meta.require', '__ccRequire');
  return { code, patched: true };
}

export async function patchSplitEsm({ extractDir, entryPath }) {
  const files = await listJsFiles(extractDir);
  const stats = { files: files.length, specifiers: 0, literals: 0, metaRequire: 0, hoisted: 0, ast: {} };

  for (const file of files) {
    let code = await readFile(file, 'utf8');
    const before = code;

    const rewritten = rewriteBunfsPaths(code, prefixFor(file, extractDir));
    code = rewritten.code;
    stats.specifiers += rewritten.specifiers;
    stats.literals += rewritten.literals;

    const hoist = hoistTopLevelChunkRequires(code, prefixFor(file, extractDir));
    code = hoist.code;
    stats.hoisted += hoist.hoisted;

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
