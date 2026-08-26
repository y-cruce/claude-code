#!/usr/bin/env bash
# One-shot installer: downloads the latest GitHub Release of this fork and
# installs it globally via npm.
#
#   curl -fsSL https://raw.githubusercontent.com/y-cruce/claude-code/master/install.sh | bash
set -euo pipefail

REPO=y-cruce/claude-code

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  MINGW*|MSYS*|CYGWIN*) os=win32 ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
platform="$os-$arch"
if [ "$os" = linux ]; then
  if [ "$(uname -o 2>/dev/null)" = Android ]; then
    platform="android-$arch"
  elif ldd --version 2>&1 | grep -qi musl; then
    platform="$platform-musl"
  fi
fi

# parse from a variable: curl | grep -m1 would die on SIGPIPE under pipefail
release_json=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")
version=$(printf '%s' "$release_json" | grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/')
[ -n "$version" ] || { echo "Could not determine the latest release" >&2; exit 1; }
echo "Installing v$version ($platform)..."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
base="https://github.com/$REPO/releases/download/v$version"
curl -fL --retry 3 -o "$tmp/main.tgz" "$base/cometix-anthropic-cc-$version.tgz"
curl -fL --retry 3 -o "$tmp/platform.tgz" "$base/cometix-anthropic-cc-$platform-$version.tgz"

npm install -g "$tmp/main.tgz" "$tmp/platform.tgz"

# npm's allow-scripts gate may skip the postinstall that copies the platform
# package's module tree into the main package — finish it manually if so.
root="$(npm root -g)/@cometix/anthropic-cc"
if [ ! -d "$root/vendor" ]; then
  echo "postinstall was skipped by npm; running it manually..."
  (cd "$root" && node install.cjs)
fi

if command -v anthropic-cc >/dev/null 2>&1; then
  echo "Installed: $(anthropic-cc --version)"
else
  echo "Installed: $(node "$root/cli.js" --version) (anthropic-cc not on PATH — check npm's global bin dir)"
fi
