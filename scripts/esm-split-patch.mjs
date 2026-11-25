import { readFile, writeFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { build } from 'esbuild';
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

// Bun names the current module folder and file `import.meta.dir` and
// `import.meta.path`; Node exposes the same values as `import.meta.dirname`
// and `import.meta.filename`. Matched on the AST so strings mentioning them
// are untouched. Any other Bun-only `import.meta.*` property fails the build.
const BUN_IMPORT_META = { dir: 'dirname', path: 'filename' };
const NODE_IMPORT_META = new Set(['url', 'dirname', 'filename', 'resolve']);
const BUN_META_TEXT = /import\.meta\.(?!(?:url|dirname|filename|resolve)\b)([A-Za-z_$][\w$]*)/g;

function importMetaReads(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return null;
  }
  const reads = [];
  (function visit(node) {
    if (node.type === 'MemberExpression' && !node.computed
        && node.object.type === 'MetaProperty'
        && node.object.meta.name === 'import' && node.object.property.name === 'meta') {
      reads.push(node.property);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) visit(item);
      } else if (child?.type) visit(child);
    }
  })(ast);
  return reads;
}

export function patchImportMetaDir(code) {
  if (!/import\.meta\.(?:dir|path)\b/.test(code)) return { code, patched: 0 };
  const sites = (importMetaReads(code) ?? []).filter((p) => Object.hasOwn(BUN_IMPORT_META, p.name));
  let out = code;
  for (const p of sites.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, p.start) + BUN_IMPORT_META[p.name] + out.slice(p.end);
  }
  return { code: out, patched: sites.length };
}

export function bunOnlyImportMeta(code) {
  const mentioned = [...code.matchAll(BUN_META_TEXT)].map((m) => m[1]);
  if (mentioned.length === 0) return [];
  const reads = importMetaReads(code);
  const names = reads ? reads.map((p) => p.name) : mentioned;
  return [...new Set(names.filter((n) => !NODE_IMPORT_META.has(n)))];
}

export function patchBuiltinHooksModuleShipping(code) {
  if (!code.includes('folder:')) return { code, patched: 0 };
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const replacements = [];

  (function visit(node) {
    if (node.type === 'ConditionalExpression' &&
        node.test?.type === 'CallExpression' && node.test.arguments.length === 0 &&
        node.consequent?.type === 'CallExpression' && node.consequent.arguments.length === 3 &&
        node.alternate?.type === 'ObjectExpression') {
      const properties = node.alternate.properties;
      const fields = new Map(properties.filter((p) => p.type === 'Property' && !p.computed)
        .map((p) => [p.key.name ?? p.key.value, p.value]));
      const [moduleArg, factoryCall, folderArg] = node.consequent.arguments;
      if (properties.length === 2 && fields.size === 2 &&
          moduleArg.type === 'Identifier' && folderArg.type === 'Identifier' &&
          factoryCall.type === 'CallExpression' && factoryCall.arguments.length === 0 &&
          fields.get('module')?.name === moduleArg.name &&
          fields.get('folder')?.name === folderArg.name) {
        replacements.push({ start: node.start, end: node.end, text: code.slice(node.consequent.start, node.consequent.end) });
      }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) visit(item);
      } else if (child?.type) visit(child);
    }
  })(ast);

  for (const replacement of replacements.reverse()) {
    code = code.slice(0, replacement.start) + replacement.text + code.slice(replacement.end);
  }
  return { code, patched: replacements.length };
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
// Bun's require also returns file CONTENT for text-loader assets (.md/.txt
// since 2.1.246, and embedded .mjs skill helpers since 2.1.302), so those go
// through readFileSync instead of executing. Object.assign keeps
// require.resolve/cache available on the wrapper.
//
// Since 2.1.250 chunks also require() OTHER CHUNKS at top level (hundreds of
// sites). Node's require(esm) refuses modules whose graph is still mid-
// evaluation in an import cycle (ERR_REQUIRE_CYCLE_MODULE) where Bun
// re-enters evaluation and returns the namespace. Node cannot re-enter, so:
// - require in a cycle → lazy NAMESPACE proxy (re-requires on first access,
//   which succeeds once the cycle has finished evaluating);
// - property read on that proxy while the cycle is STILL evaluating (the
//   top-level `var X=require(chunk).Prop` pattern) → lazy VALUE proxy,
//   cached per (module, prop) in globalThis.__ccLazyVals so every grabber
//   gets the identical object and === comparisons between them keep working.
const TEXT_LOADER_EXT = /\.(?:md|txt|mjs)$/;

export function patchImportMetaRequire(code) {
  if (!code.includes('import.meta.require')) return { code, patched: false };
  const inject = 'import{createRequire as __ccMakeRequire}from"module";'
    + 'import{readFileSync as __ccReadAsset}from"fs";'
    + 'const __ccRawRequire=__ccMakeRequire(import.meta.url);'
    + 'const __ccCyclic=(e)=>e&&e.code==="ERR_REQUIRE_CYCLE_MODULE";'
    + 'const __ccPeek=(id,p)=>{try{return{ok:!0,v:__ccRawRequire(id)[p]}}'
    + 'catch(e){if(__ccCyclic(e))return{ok:!1};throw e}};'
    + 'globalThis.__ccLazyVals??=new Map();'
    + 'const __ccLazyVal=(id,p)=>{const k=id+"\\0"+p,m=globalThis.__ccLazyVals;'
    + 'if(m.has(k))return m.get(k);'
    + 'let v,got=!1;const g=()=>{if(!got){const r=__ccPeek(id,p);if(r.ok){v=r.v;got=!0}}return v};'
    // target must be callable, constructible, and free of non-configurable own
    // props (a plain function has non-configurable `prototype`, breaking ownKeys
    // and getOwnPropertyDescriptor for object exports); a bound fn satisfies all 3
    + 'const px=new Proxy((function(){}).bind(),{get:(_,q)=>{const t=g();'
    + 'if(t==null)return void 0;const x=t[q];'
    + 'return typeof x==="function"?x.bind(t):x},'
    + 'apply:(_,th,a)=>Reflect.apply(g(),th,a),'
    + 'construct:(_,a)=>Reflect.construct(g(),a),'
    + 'has:(_,q)=>{const t=g();return t!=null&&q in t},'
    + 'ownKeys:()=>{const t=g();return t==null?[]:Reflect.ownKeys(t)},'
    + 'getOwnPropertyDescriptor:(_,q)=>{const t=g(),'
    + 'd=t==null?void 0:Reflect.getOwnPropertyDescriptor(t,q);'
    + 'if(d)d.configurable=!0;return d},'
    + 'getPrototypeOf:()=>{const t=g();return t==null?null:Reflect.getPrototypeOf(Object(t))}});'
    + 'm.set(k,px);return px};'
    + 'const __ccLazyNs=(id)=>new Proxy({},{'
    + 'get:(_,p)=>{const m=globalThis.__ccLazyVals;'
    + 'if(typeof p==="string"&&m.has(id+"\\0"+p))return m.get(id+"\\0"+p);'
    + 'const r=__ccPeek(id,p);'
    + 'if(r.ok)return r.v;'
    + 'if(typeof p!=="string"||p==="then")return void 0;'
    + 'return __ccLazyVal(id,p)},'
    + 'has:(_,p)=>{try{return p in __ccRawRequire(id)}catch(e){if(__ccCyclic(e))return!1;throw e}},'
    + 'ownKeys:()=>{try{return Reflect.ownKeys(__ccRawRequire(id))}catch(e){if(__ccCyclic(e))return[];throw e}},'
    + 'getOwnPropertyDescriptor:(_,p)=>{try{const d=Reflect.getOwnPropertyDescriptor(__ccRawRequire(id),p);'
    + 'if(d)d.configurable=!0;return d}catch(e){if(__ccCyclic(e))return void 0;throw e}},'
    + 'getPrototypeOf:()=>{try{return Reflect.getPrototypeOf(__ccRawRequire(id))}catch(e){if(__ccCyclic(e))return null;throw e}}});'
    + 'const __ccRequire=Object.assign((id)=>{'
    + `if(${TEXT_LOADER_EXT}.test(id))return __ccReadAsset(id,"utf8");`
    + 'try{return __ccRawRequire(id)}catch(e){'
    + 'if(__ccCyclic(e))return __ccLazyNs(id);'
    + 'throw e}},__ccRawRequire);';
  const at = firstStatementStart(code);
  code = code.slice(0, at) + inject + code.slice(at);
  code = code.replaceAll('import.meta.require', '__ccRequire');
  return { code, patched: true };
}

// E6: replace only the Worker whose URL provider names the hooks entry.
// Other libraries probe global Worker to choose their Node fallback.
export function patchHooksWorker(code) {
  if (!code.includes('HOOKS_WORKER_URL') || !code.includes('Worker')) return { code, patched: 0 };
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const providers = new Set();
  const workers = [];
  (function visit(node, defaults) {
    const binding = node.type === 'VariableDeclarator' ? node.init
      : node.type === 'FunctionDeclaration' ? node.body : null;
    if (binding && node.id?.type === 'Identifier') {
      const source = code.slice(binding.start, binding.end);
      if (source.includes('HOOKS_WORKER_URL') && source.includes('hooks-worker.js')) providers.add(node.id.name);
    }
    // 2.1.295+ passes the URL through a parameter default: function f(url = provider()) { new Worker(url, ...) }
    if (node.params) {
      defaults = new Map(defaults);
      for (const param of node.params) {
        if (param.type === 'AssignmentPattern' && param.left.type === 'Identifier') defaults.set(param.left.name, param.right);
        else if (param.type === 'Identifier') defaults.delete(param.name);
      }
    }
    if (node.type === 'NewExpression' && node.callee.name === 'Worker') {
      const url = node.arguments[0];
      workers.push({ node, url: url?.type === 'Identifier' ? defaults.get(url.name) : url });
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) visit(item, defaults);
      } else if (child?.type) visit(child, defaults);
    }
  })(ast, new Map());
  const matches = workers.filter(({ url }) => url?.type === 'CallExpression' && providers.has(url.callee.name))
    .map(({ node }) => node);
  for (const node of matches.reverse()) {
    code = code.slice(0, node.callee.start) + 'globalThis.__ccHooksWorker' + code.slice(node.callee.end);
  }
  return { code, patched: matches.length };
}

// E7: plugin test filters NODE_OPTIONS before starting each test file on Node.
// Wrap whatever expression builds `env` (call, object of spreads, shorthand)
// so child processes get --experimental-vm-modules.
const PLUGIN_TEST_ARGV = /['"]plugin['"]\s*,\s*['"]test['"]\s*,\s*['"]--file['"]/;
const VM_MODULES_NODE_OPTIONS = '--experimental-vm-modules --disable-warning=ExperimentalWarning';

const propertyNamed = (object, name) => object.properties.find((p) =>
  p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === name);

export function patchPluginTestVm(code) {
  if (!PLUGIN_TEST_ARGV.test(code)) return { code, patched: 0 };
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return { code, patched: 0 };
  }
  const sites = [];
  (function visit(node) {
    if (node.type === 'CallExpression') {
      const [, argv, options] = node.arguments;
      const args = argv?.type === 'ArrayExpression' ? argv.elements : [];
      const isTest = args.some((arg, i) => arg?.value === 'plugin'
        && args[i + 1]?.value === 'test' && args[i + 2]?.value === '--file');
      const env = isTest && options?.type === 'ObjectExpression'
        ? propertyNamed(options, 'env') : null;
      const settled = env?.value.type === 'ObjectExpression'
        && propertyNamed(env.value, 'NODE_OPTIONS');
      if (env && !settled) sites.push(env);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) visit(item);
      } else if (child?.type) visit(child);
    }
  })(ast);
  let out = code;
  for (const prop of sites.sort((a, b) => b.start - a.start)) {
    const value = out.slice(prop.value.start, prop.value.end);
    out = out.slice(0, prop.start)
      + `env:{...(${value}),NODE_OPTIONS:${JSON.stringify(VM_MODULES_NODE_OPTIONS)}}`
      + out.slice(prop.end);
  }
  return { code: out, patched: sites.length };
}

// E8: 2.1.321 refuses to make a node:vm context when its build-time "is Bun"
// flag is set and the runtime cannot vouch for the context's global. The flag
// is a constant true in the bundle, so on Node every plugin hooks module
// failed to load. Ask the real runtime instead; the guard stays for Bun.
const VM_GUARD = 'Refusing to make a node:vm context';
export function patchVmContextGuard(code) {
  if (!code.includes(VM_GUARD)) return { code, patched: 0 };
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const tests = [];
  (function visit(node) {
    if (node.type === 'IfStatement' && node.consequent.type === 'ThrowStatement'
      && code.slice(node.consequent.start, node.consequent.end).includes(VM_GUARD)
      && !code.slice(node.test.start, node.test.end).includes('process.versions.bun')) tests.push(node.test);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) visit(item);
      } else if (child?.type) visit(child);
    }
  })(ast);
  for (const test of tests.sort((a, b) => b.start - a.start)) {
    code = `${code.slice(0, test.start)}typeof process.versions.bun==="string"&&(${code.slice(test.start, test.end)})${code.slice(test.end)}`;
  }
  return { code, patched: tests.length };
}

// E9: headless reload installs a new MCP client while no turn is running.
// Wire its channel on the existing clients-change subscription, before the
// channel's startup probes run out. Derive all bundle identifiers from the AST.
const CHANNEL_RECONNECT = 'Channel notifications re-registered after reconnect';
export function patchHeadlessChannelHandlers(code) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const handlers = new Set();
  const properties = [];
  const subscriptions = [];
  const walk = (node, visit, scope = null) => {
    if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) scope = node;
    visit(node, scope);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) walk(item, visit, scope);
      } else if (child?.type) walk(child, visit, scope);
    }
  };
  walk(ast, (node, scope) => {
    if (node.type === 'Literal' && node.value === CHANNEL_RECONNECT) handlers.add(scope?.id?.name);
    if (node.type === 'Property' && (node.key.name ?? node.key.value) === 'registerChannelHandler') properties.push({ node, scope });
    if (node.type === 'CallExpression' && node.arguments.length === 1 &&
        node.arguments[0].type === 'ArrowFunctionExpression' && node.arguments[0].params.length === 0 &&
        node.arguments[0].body.type === 'BlockStatement') subscriptions.push({ node, scope });
  });
  const registrations = properties.filter(({ node }) => {
    const value = node.value;
    return value.type === 'ArrowFunctionExpression' && value.params.length === 1 &&
      value.body.type === 'CallExpression' && handlers.has(value.body.callee.name) &&
      value.body.arguments.length === 2 && value.body.arguments[0].name === value.params[0].name &&
      value.body.arguments[1].type === 'Identifier';
  });
  if (handlers.size !== 1 || handlers.has(undefined) || registrations.length !== 1) {
    throw new Error('E9: expected one headless registerChannelHandler anchor');
  }
  const registration = registrations[0];
  const matches = [];
  for (const subscription of subscriptions.filter(s => s.scope === registration.scope)) {
    const body = subscription.node.arguments[0].body;
    const rows = body.body.filter(n => n.type === 'VariableDeclaration').flatMap(n => n.declarations)
      .filter(n => n.id.type === 'Identifier' && n.init?.type === 'MemberExpression' &&
        n.init.property.name === 'clients' && n.init.object.type === 'MemberExpression' &&
        n.init.object.property.name === 'mcp' && n.init.object.object.type === 'CallExpression');
    for (const row of rows) {
      const guard = body.body.find(n => n.type === 'IfStatement' && n.test.type === 'BinaryExpression' &&
        n.test.operator === '===' && n.test.left.name === row.id.name &&
        n.test.right.type === 'Identifier' && n.consequent.type === 'ReturnStatement');
      if (!guard) continue;
      let updatesPrevious = false;
      walk(body, n => {
        if (n.type === 'AssignmentExpression' && n.operator === '=' &&
            n.left.name === guard.test.right.name && n.right.name === row.id.name) updatesPrevious = true;
      });
      if (updatesPrevious) matches.push({ body, rows: row.id.name });
    }
  }
  if (matches.length !== 1) throw new Error(`E9: expected one headless MCP clients-change callback, found ${matches.length}`);
  const { body, rows } = matches[0];
  const call = registration.node.value.body;
  const insert = `;${rows}.forEach((__ccChannelClient)=>${call.callee.name}(__ccChannelClient,${call.arguments[1].name}));`;
  code = code.slice(0, body.end - 1) + insert + code.slice(body.end - 1);
  return { code, patched: 1 };
}

// E10: background workers opt into the channels named by CC_FORK_CHANNELS.
// Merge before the normal parser/setter so all existing channel gates apply.
const CHANNEL_FLAGS = 'tengu_mcp_channel_flags';
export function patchBackgroundChannelDefaults(code) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const matches = [];
  const walk = (node) => {
    if (node.type === 'BlockStatement') {
      for (let i = 0; i < node.body.length; i++) {
        const declaration = node.body[i];
        if (declaration.type !== 'VariableDeclaration') continue;
        for (const binding of declaration.declarations) {
          if (binding.id.type !== 'ObjectPattern') continue;
          const property = key => binding.id.properties.find(p => p.type === 'Property' && (p.key.name ?? p.key.value) === key);
          const channels = property('channels')?.value;
          if (channels?.type !== 'Identifier' || !property('dangerouslyLoadDevelopmentChannels')) continue;
          const guard = node.body[i + 1];
          const test = guard?.test;
          const length = test?.right;
          const sequence = guard?.consequent?.expression;
          if (guard?.type !== 'IfStatement' || guard.alternate !== null ||
              test?.type !== 'LogicalExpression' || test.operator !== '&&' || test.left.name !== channels.name ||
              length?.type !== 'BinaryExpression' || length.operator !== '>' || length.right.value !== 0 ||
              length.left.type !== 'MemberExpression' || length.left.object.name !== channels.name || length.left.property.name !== 'length' ||
              sequence?.type !== 'SequenceExpression' || sequence.expressions.length !== 2) continue;
          const [assignment, setter] = sequence.expressions;
          const parser = assignment.right;
          if (assignment.type !== 'AssignmentExpression' || assignment.operator !== '=' || assignment.left.type !== 'Identifier' ||
              parser?.type !== 'CallExpression' || parser.callee.type !== 'Identifier' || parser.arguments.length !== 2 ||
              parser.arguments[0].name !== channels.name || parser.arguments[1].value !== '--channels' ||
              setter.type !== 'CallExpression' || setter.callee.type !== 'Identifier' || setter.arguments.length !== 1 ||
              setter.arguments[0].name !== assignment.left.name) continue;
          const output = declaration.declarations.find(d => d.id.name === assignment.left.name);
          if (output?.init?.type !== 'ArrayExpression' || output.init.elements.length !== 0) continue;
          matches.push({ declaration, channels: channels.name, guard });
        }
      }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) walk(item);
      } else if (child?.type) walk(child);
    }
  };
  walk(ast);
  if (matches.length !== 1) throw new Error(`E10: expected one background channel startup anchor, found ${matches.length}`);
  const { declaration, channels, guard } = matches[0];
  if (declaration.kind !== 'let') throw new Error('E10: channel list must be a let binding');
  const insert = `if(process.env.CLAUDE_CODE_SESSION_KIND==="bg"&&process.env.CC_FORK_CHANNELS)${channels}=[...new Set([...(${channels}??[]),...process.env.CC_FORK_CHANNELS.split(/[\\s,]+/).filter(Boolean)])];`;
  code = code.slice(0, guard.start) + insert + code.slice(guard.start);
  acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  return { code, patched: 1 };
}

// E11: Code Mode (2.1.323+) admits only the native Bun build: the runtime
// gate asks "is Bun standalone" and the engine check needs bun:jsc. With
// CLAUDE_CODE_NODE_UNSAFE_CODE_MODE=1 on Node, both pass (E11a, E11b); every
// other gate stays. Node's vm is not a security boundary, so this is opt-in.
const CODE_MODE_OPT_IN = 'typeof process.versions.bun!=="string"&&process.env.CLAUDE_CODE_NODE_UNSAFE_CODE_MODE==="1"';
const CODE_MODE_ENV = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE';
const ENGINE_CHECK = '"not_bun"';
function returnsLiteral(node, value) {
  return node.type === 'IfStatement' && node.alternate === null && node.consequent.type === 'ReturnStatement' &&
    node.consequent.argument?.type === 'Literal' && node.consequent.argument.value === value &&
    node.test.type === 'UnaryExpression' && node.test.operator === '!' &&
    node.test.argument.type === 'CallExpression' && node.test.argument.arguments.length === 0;
}
export function patchNodeCodeMode(code) {
  const admission = code.includes(CODE_MODE_ENV) && code.includes('"runtime"');
  const engine = code.includes(ENGINE_CHECK);
  if (!admission && !engine) return { code, admission: 0, engine: 0 };
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const edits = [];
  let admissions = 0, engines = 0;
  (function visit(node) {
    // E11a: if(!z())return"runtime" -> if(!(z()||opt-in))return"runtime"
    if (admission && returnsLiteral(node, 'runtime')) {
      const call = node.test.argument;
      edits.push({ at: call.start, text: '(' }, { at: call.end, text: `||${CODE_MODE_OPT_IN})` });
      admissions++;
    }
    // E11b: if(!hh())return"not_bun" -> preceded by if(opt-in)return"passed"
    if (engine && returnsLiteral(node, 'not_bun')) {
      edits.push({ at: node.start, text: `if(${CODE_MODE_OPT_IN})return"passed";` });
      engines++;
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) visit(item);
      } else if (child?.type) visit(child);
    }
  })(ast);
  for (const { at, text } of edits.sort((a, b) => b.at - a.at)) code = code.slice(0, at) + text + code.slice(at);
  return { code, admission: admissions, engine: engines };
}

// E12: Bun resolves `node-fetch` to a built-in; Node has no such package.
// Repoint specifier positions to templates/node-fetch-compat.mjs via AST so
// plain string literals mentioning "node-fetch" (e.g. embedded package.json)
// are left untouched.
const NODE_FETCH_MODULE = 'node-fetch-compat.mjs';

export function rewriteNodeFetch(code, prefix) {
  if (!code.includes('node-fetch')) return { code, rewritten: 0 };
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return { code, rewritten: 0 };
  }
  const sites = [];
  (function visit(node) {
    const source = (node.type === 'ImportDeclaration'
      || node.type === 'ImportExpression'
      || node.type === 'ExportNamedDeclaration'
      || node.type === 'ExportAllDeclaration') ? node.source : null;
    if (source?.type === 'Literal' && source.value === 'node-fetch') sites.push(source);
    if (node.type === 'CallExpression'
        && node.callee?.type === 'Identifier' && node.callee.name === 'require'
        && node.arguments[0]?.type === 'Literal'
        && node.arguments[0].value === 'node-fetch') {
      sites.push(node.arguments[0]);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) visit(item);
      } else if (child?.type) visit(child);
    }
  })(ast);
  let out = code;
  for (const node of sites.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, node.start)
      + JSON.stringify(`${prefix}${NODE_FETCH_MODULE}`)
      + out.slice(node.end);
  }
  return { code: out, rewritten: sites.length };
}

export async function patchSplitEsm({ extractDir, entryPath }) {
  const files = await listJsFiles(extractDir);
  const stats = { files: files.length, specifiers: 0, literals: 0, metaRequire: 0, metaDir: 0, builtinHooks: 0, hoisted: 0, hooksWorkers: 0, pluginTestMarkers: 0, pluginTests: 0, nodeFetch: 0, vmGuards: 0, vmGuardFiles: 0, headlessChannels: 0, backgroundChannels: 0, codeModeFiles: 0, codeModeAdmission: 0, codeModeEngine: 0, ast: {} };
  const bunOnly = [];

  for (const file of files) {
    let code = await readFile(file, 'utf8');
    const before = code;
    const prefix = prefixFor(file, extractDir);

    const rewritten = rewriteBunfsPaths(code, prefix);
    code = rewritten.code;
    stats.specifiers += rewritten.specifiers;
    stats.literals += rewritten.literals;

    const metaDir = patchImportMetaDir(code);
    code = metaDir.code;
    stats.metaDir += metaDir.patched;

    const builtinHooks = patchBuiltinHooksModuleShipping(code);
    code = builtinHooks.code;
    stats.builtinHooks += builtinHooks.patched;

    const hooksWorker = patchHooksWorker(code);
    code = hooksWorker.code;
    stats.hooksWorkers += hooksWorker.patched;

    if (PLUGIN_TEST_ARGV.test(code)) stats.pluginTestMarkers += 1;
    const pluginTest = patchPluginTestVm(code);
    code = pluginTest.code;
    stats.pluginTests += pluginTest.patched;

    const nodeFetch = rewriteNodeFetch(code, prefix);
    code = nodeFetch.code;
    stats.nodeFetch += nodeFetch.rewritten;

    if (code.includes(VM_GUARD)) stats.vmGuardFiles += 1;
    const vmGuard = patchVmContextGuard(code);
    code = vmGuard.code;
    stats.vmGuards += vmGuard.patched;

    if (code.includes(CODE_MODE_ENV)) stats.codeModeFiles += 1;
    const codeMode = patchNodeCodeMode(code);
    code = codeMode.code;
    stats.codeModeAdmission += codeMode.admission;
    stats.codeModeEngine += codeMode.engine;

    if (code.includes(CHANNEL_RECONNECT)) {
      const channel = patchHeadlessChannelHandlers(code);
      code = channel.code;
      stats.headlessChannels += channel.patched;
    }

    if (code.includes(CHANNEL_FLAGS)) {
      const channel = patchBackgroundChannelDefaults(code);
      code = channel.code;
      stats.backgroundChannels += channel.patched;
    }

    const hoist = hoistTopLevelChunkRequires(code, prefix);
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
    const rel = relative(extractDir, file);
    for (const name of bunOnlyImportMeta(code)) bunOnly.push(`${rel}: import.meta.${name}`);
  }

  if (bunOnly.length > 0) {
    throw new Error(`Bun-only import.meta properties remain after patching:\n  ${bunOnly.join('\n  ')}`);
  }

  const workerEntries = files.filter((f) => f.endsWith('hooks-worker.js'));
  if (workerEntries.length > 0 && stats.hooksWorkers !== 1) {
    throw new Error(`expected one hooks Worker creation site, patched ${stats.hooksWorkers}`);
  }

  if (stats.pluginTestMarkers > 0 && stats.pluginTests === 0) {
    throw new Error(`E7: plugin test child argv found in ${stats.pluginTestMarkers} module(s), but no spawn site was patched`);
  }

  if (stats.vmGuardFiles > 0 && stats.vmGuards === 0) {
    throw new Error('found the node:vm context guard but could not patch it');
  }

  if (stats.codeModeFiles > 0 && (stats.codeModeAdmission !== 1 || stats.codeModeEngine !== 1)) {
    throw new Error(`E11: expected one Code Mode runtime gate and one engine check, patched ${stats.codeModeAdmission} and ${stats.codeModeEngine}`);
  }

  if (stats.headlessChannels !== 1) {
    throw new Error(`E9: expected one headless channel handler patch, patched ${stats.headlessChannels}`);
  }

  if (stats.backgroundChannels !== 1) {
    throw new Error(`E10: expected one background channel startup patch, patched ${stats.backgroundChannels}`);
  }

  // Bundle JS helpers, including @img/colour; only sharp's native packages stay external.
  await build({
    absWorkingDir: join(__dirname, '..'),
    entryPoints: {
      'bun-transpiler-compat': join(__dirname, '..', 'templates', 'bun-transpiler-compat.cjs'),
      'bun-toml-compat': 'smol-toml',
      'bun-sharp-compat': 'sharp',
    },
    outdir: extractDir,
    outExtension: { '.js': '.cjs' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', minify: true,
    external: ['@img/sharp-*'],
  });
  await writeFile(join(extractDir, 'bun-image-compat.cjs'),
    readFileSync(join(__dirname, '..', 'templates', 'bun-image-compat.cjs')));
  await writeFile(join(extractDir, NODE_FETCH_MODULE),
    readFileSync(join(__dirname, '..', 'templates', NODE_FETCH_MODULE)));

  // Bun polyfill, ESM-wrapped, next to the entry
  let polyfill = readFileSync(join(__dirname, '..', 'templates', 'bun-polyfill.js'), 'utf8');
  polyfill = polyfill.replace(/^#![^\n]*\n/, '');
  await writeFile(join(extractDir, 'bun-polyfill.mjs'), ESM_PRELUDE + polyfill + ESM_HELPERS);

  // The polyfill has to be the entry's first import so that globalThis.Bun
  // exists before any chunk body runs. Worker entrypoints need it too.
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
