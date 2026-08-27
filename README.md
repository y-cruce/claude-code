# @cometix/anthropic-cc

Claude Code restored for Node.js — extracted from official Bun SEA binaries and patched for Node.js runtime compatibility.

Starting from v2.1.113, Anthropic ships Claude Code as native Bun binaries instead of Node.js-runnable JavaScript. This project restores the npm package format so it can run under Node.js.

## Install

Not published to npm — installs from this repo's GitHub Releases. One-shot installer (detects your platform, downloads the latest release, installs globally):

```bash
curl -fsSL https://raw.githubusercontent.com/y-cruce/claude-code/master/install.sh | bash
```

Or manually — the main package plus the package for your platform:

```bash
VERSION=$(gh release view --repo y-cruce/claude-code --json tagName --jq '.tagName | ltrimstr("v")')
PLATFORM=darwin-arm64  # or darwin-x64 / linux-{x64,arm64}[-musl] / win32-{x64,arm64} / android-arm64
gh release download "v$VERSION" --repo y-cruce/claude-code \
  -p "cometix-anthropic-cc-$VERSION.tgz" \
  -p "cometix-anthropic-cc-$PLATFORM-$VERSION.tgz"
npm install -g "./cometix-anthropic-cc-$VERSION.tgz" "./cometix-anthropic-cc-$PLATFORM-$VERSION.tgz"
```

The CLI installs as `anthropic-cc`. If npm's allow-scripts gate skips the postinstall (it copies the platform package's module tree into the main package), finish it manually:

```bash
cd "$(npm root -g)/@cometix/anthropic-cc" && node install.cjs
```

## What it does

1. Downloads official Claude Code binaries from all 8 platforms (darwin/linux/win32 × arm64/x64)
2. Extracts the embedded JavaScript and native modules from Bun SEA format
3. Patches the code for Node.js compatibility (hardcoded paths, Bun-only APIs, module loading)
4. Reassembles into a standard npm package with `vendor/` dependencies

## Bundle layouts

The official binary has changed shape twice, so the pipeline detects which one it is looking at before patching (`scripts/verify-node-compat.mjs`):

| Layout | Versions | Shape |
|--------|----------|-------|
| `single-cjs` | ≤ 2.1.241 | One ~28MB CommonJS bundle, patched as a single `cli.js` |
| `split-esm` | ≥ 2.1.242 | A ~19KB ESM entry plus ~1400 code-split modules (`chunk-*.js`, joined by `_N.js` names since 2.1.246) importing each other through Bun's virtual filesystem (`/$bunfs/root/`, or `B:/~BUN/root/` on Windows) |

Split builds are patched directory-wide by `scripts/esm-split-patch.mjs`:

| Rewrite | Description |
|---------|-------------|
| E1 | Import specifiers `"/$bunfs/root/chunk-x.js"` → relative `"./chunk-x.js"` (~110k per platform), so Node's ESM resolver finds the chunks shipped next to `cli.js` |
| E2 | The remaining virtual-filesystem literals (~258 at 2.1.242, ~424 at 2.1.246) are runtime paths, not specifiers: native modules resolve through `globalThis.__ccVendorNode()` to the package's `vendor/` copy; assets (mermaid, chart.js, highlight.js, the HTML payload template, and since 2.1.246 embedded `.md`/`.txt` prompt files) and the hooks worker resolve through `globalThis.__ccAsset()` |
| E3 | `import.meta.require` (Bun-only) → a `createRequire` wrapper that returns file *content* for `.md`/`.txt` paths, matching Bun's text loader — since 2.1.246 chunks `require()` embedded prompt files and would otherwise crash at startup compiling markdown as JS |
| E4 | The P6 polyfill ships as `bun-polyfill.mjs`, imported first by `cli.js` and by the hooks worker so `globalThis.Bun` exists before any chunk body runs |

The patches below still apply to split builds. Only the few chunks carrying their marker strings are AST-walked — parsing all 1385 modules would cost minutes per platform.

## Compatibility patches

Applied by `scripts/node-compat-patch.mjs` — to the extracted `cli.js` (~27MB) on `single-cjs` builds, and to the matching chunks on `split-esm` builds. Each patch degrades gracefully: a pattern that no longer matches logs a warning instead of aborting, and the result is AST-validated before packaging.

| Patch | Description |
|-------|-------------|
| P1 | Hardcoded CI build paths baked in at compile time (`fileURLToPath("file:///home/runner/...")` / `createRequire("file:///home/runner/...")`) → runtime `__filename` / `require` |
| P2 | `if (typeof Bun > "u") throw Error("Bun required")` guard around `Bun.Transpiler` → graceful `null` return. Not present since recent versions — the P6 polyfill covers it |
| P3 | `require("/$bunfs/root/*.node")` — Bun SEA's virtual filesystem paths for native modules → resolved from the package's `vendor/` directory |
| P5 | `EMBEDDED_SEARCH_TOOLS` guard restored (P5a: env var check, P5b: binary availability check) — enables Grep/Glob Tool by default; set `EMBEDDED_SEARCH_TOOLS=true` to switch to bfs/ugrep Bash shadow mode (falls back to Tool mode if binaries are missing) |
| P6 | Global `Bun` polyfill shim injected at the top of the file. Implements `Bun.spawn` (Subprocess-like interface), `Bun.file`, `Bun.listen` (TCP), `Bun.serve` (HTTP/S), `Bun.hash`, `Bun.deepEquals`, `Bun.stdin`; `Bun.JSONL.parseChunk` is intentionally `null` so business code takes its own fallback path; `Bun.SQL` throws a clear not-implemented error; `Bun.Terminal`/`Bun.WebView`/heap-snapshot APIs are guarded no-ops. Skipped when the code contains ≥10 `typeof Bun` guards (dual-runtime fallbacks already present) |
| P7 | Bundled `HttpsProxyAgent` exposed as `globalThis.__HttpsProxyAgent` — Node's `ws` needs an explicit agent to honor HTTP(S) proxies, unlike the Bun runtime |
| P8 | `AF_()` shadow function patched — the official binary is a multicall executable that impersonates `bfs`/`ugrep` via ARGV0; under Node.js the binaries are resolved from PATH via `which` instead |
| P9 | Package name rebranded: all `@anthropic-ai/claude-code` references (~250 occurrences) → `@cometix/anthropic-cc`, so the built-in auto-updater installs this package instead of the official Bun build |
| P10 | CONNECT tunneling for axios behind `HTTP(S)_PROXY` (ships inside the P6 polyfill). The bundled axios sends HTTPS requests to the proxy as absolute-form cleartext HTTP instead of opening a CONNECT tunnel, so its clients — most visibly `claude remote-control` registration — die with `Registration: Failed with status 400` behind a proxy ([upstream bug](https://github.com/anthropics/claude-code/issues/71781), the official Bun build fails the same way). The polyfill intercepts `http.request` calls whose `path` is an absolute `https://` URL (only axios's proxy mode produces those) and reissues them as real HTTPS requests tunneled via CONNECT |

Outside the patcher, the package also ships `bun-ink-compat.cjs` (precompiled ansi-regex/strip-ansi/string-width/ansi-styles/wrap-ansi for terminal text handling) and `install.cjs` (postinstall: detects platform incl. musl/Android, copies the platform package's files — `cli.js` + `vendor/`, or the whole chunk tree on split builds — into the main package).

## Search tools

Claude Code has two search paths, controlled by the `EMBEDDED_SEARCH_TOOLS` environment variable:

| Mode | Env setting | Search method | Requirements |
|------|------------|---------------|-------------|
| **Tool mode** (default) | unset | Grep/Glob Tool → ripgrep (bundled) | None |
| **Shadow mode** | `=true` | Bash `find` → bfs, `grep` → ugrep | bfs + ugrep installed |

In Tool mode, the model uses the built-in Grep and Glob tools powered by bundled ripgrep. In Shadow mode, `find`/`grep` commands in the Bash tool are redirected to bfs/ugrep for enhanced search.

If `EMBEDDED_SEARCH_TOOLS=true` is set but bfs/ugrep are not installed, it automatically falls back to Tool mode.

```bash
# Tool mode (default, recommended)
claude

# Shadow mode (requires: brew install bfs ugrep)
EMBEDDED_SEARCH_TOOLS=true claude
```

## Package contents

```
cli.js              Node.js entry point
sdk-tools.d.ts      SDK type definitions
vendor/
├── ripgrep/         Code search (6 platforms)
├── audio-capture/   Voice input (6 platforms)
└── seccomp/         Linux sandbox (arm64 + x64)
```

On `split-esm` builds (2.1.242+) the entry is joined by the rest of the module tree:

```
cli.js              ESM entry point
bun-polyfill.mjs    Bun API shim, imported first
chunk-*.js, _*.js   ~1400 code-split modules
*.md, *.txt         Embedded prompt texts (since 2.1.246)
mermaid.min.js      Assets loaded at runtime
chart.umd.min.js
hljsBundle.generated.min.js
payload.template.html.asset
src/plugins/functionHooks/hooks-worker/hooks-worker.js
```

## Releases (this fork)

This fork does **not** publish to npm — builds produce GitHub Release artifacts only (see [Install](#install)). A scheduled run at 00:00 UTC daily picks up new upstream versions automatically; a specific version can also be built manually:

```bash
gh workflow run release.yml -f version=<x.y.z>
```

Fork changes on top of upstream:

- Support the flattened Bun SEA layout introduced in v2.1.229 (`cli.js` moved from `src/entrypoints/` to the extract root) — this is what stalls upstream builds from v2.1.229 on
- Support the split-ESM layout introduced in v2.1.242 (one CJS bundle replaced by an ESM entry plus ~1385 chunks) — see [Bundle layouts](#bundle-layouts)
- Bun text-loader semantics for `require()` of embedded `.md`/`.txt` prompt assets — without this, ≥ 2.1.246 crashes at startup (see E3)
- Daily scheduled build (00:00 UTC) that auto-detects and releases new upstream versions
- CI verify step fails on startup crashes (`pipefail` — a crash behind `| head` used to pass) and smoke-tests `mcp list`
- Retry binary downloads on transient CDN errors (`curl --retry`)
- npm publish job removed from the release workflow

## License

This project redistributes Claude Code under [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance). Vendored dependencies retain their original licenses (ripgrep: Unlicense/MIT, seccomp: Apache-2.0).
