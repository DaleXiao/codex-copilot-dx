#!/bin/sh
# CCDX release bootstrap. No administrator privileges or system package manager.
set -eu
version=1.2.19
base="https://github.com/DaleXiao/codex-copilot-dx/releases/download/v$version"
permission=
case "${1-}" in '' ) ;; --allow-remote) permission=--allow-remote ;; *) echo 'Use: sh install.sh [--allow-remote]' >&2; exit 2 ;; esac
[ "$#" -le 1 ] || exit 2
command -v curl >/dev/null 2>&1 || { echo 'curl is required. Use an approved OS download tool to obtain the Release files.' >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/ccdx-bootstrap.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
download() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 "$1" -o "$2"; }
checksum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1; else shasum -a 256 "$1" | cut -d ' ' -f 1; fi; }
private=0
node_bin=$(command -v node || true)
npm_bin=$(command -v npm || true)
if [ -n "$node_bin" ] && [ -n "$npm_bin" ] && "$node_bin" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=15?0:1)' 2>/dev/null; then
  npm_cli=$("$node_bin" -e 'const fs=require("fs");process.stdout.write(fs.realpathSync(process.argv[1]))' "$npm_bin")
  prefix=$("$node_bin" "$npm_cli" prefix --global)
else
  private=1
  prefix="${npm_config_prefix:-${NPM_CONFIG_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/ccdx}}"
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) platform=darwin-arm64; hash=6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5 ;;
    Darwin/x86_64) platform=darwin-x64; hash=495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91 ;;
    Linux/aarch64|Linux/arm64) platform=linux-arm64; hash=b7e7991d5407815adfa74a2a9cd4db683552c8ce32ff4a295c22e972849c3f5d ;;
    Linux/x86_64) platform=linux-x64; hash=28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c ;;
    *) echo 'No tested private Node build for this platform. Keep your existing installation; use an approved Node 22.15+ distribution.' >&2; exit 1 ;;
  esac
  # Linux musl users may reuse an existing compatible Node; never install glibc.
  if [ "$(uname -s)" = Linux ] && ldd --version 2>&1 | head -1 | grep -qi musl; then
    echo 'Install an approved musl-compatible Node 22.15+ first; no system libraries were changed.' >&2; exit 1
  fi
  runtime="$prefix/runtime/node-v24.22.0-$platform"
  if [ ! -x "$runtime/bin/node" ]; then
    echo 'Downloading official Node 24.22.0 for CCDX only…'
    download "https://nodejs.org/dist/v24.22.0/node-v24.22.0-$platform.tar.gz" "$work/node.tar.gz"
    [ "$(checksum "$work/node.tar.gz")" = "$hash" ] || { echo 'Node checksum mismatch. Installation stopped.' >&2; exit 1; }
    tar -xzf "$work/node.tar.gz" -C "$work"
    "$work/node-v24.22.0-$platform/bin/node" --version >/dev/null
    mkdir -p "$prefix/runtime"
    mv "$work/node-v24.22.0-$platform" "$runtime"
  fi
  node_bin="$runtime/bin/node"
  npm_cli="$runtime/lib/node_modules/npm/bin/npm-cli.js"
fi
[ -f "$npm_cli" ] || { echo 'npm is missing from this Node installation. Ask your administrator for a complete Node/npm distribution.' >&2; exit 1; }
download "$base/SHA256SUMS" "$work/SHA256SUMS"
download "$base/ccdx-install.mjs" "$work/ccdx-install.mjs"
expected=$(awk '$2=="ccdx-install.mjs" {print $1}' "$work/SHA256SUMS")
[ "$(checksum "$work/ccdx-install.mjs")" = "$expected" ] || { echo 'Installer checksum mismatch. Installation stopped.' >&2; exit 1; }
if [ "$private" = 1 ]; then
  "$node_bin" "$work/ccdx-install.mjs" "v$version" "$prefix" "$npm_cli" --private-runtime ${permission:+"$permission"}
else
  "$node_bin" "$work/ccdx-install.mjs" "v$version" "$prefix" "$npm_cli" ${permission:+"$permission"}
fi
echo "Start CCDX: $prefix/bin/ccdx"
if [ "$private" = 1 ]; then echo "For the ccdx command, add $prefix/bin to your PATH. Existing shell settings were preserved."; fi
