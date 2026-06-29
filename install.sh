#!/usr/bin/env bash
# squirm installer — downloads a prebuilt binary from GitHub Releases.
#   curl -fsSL https://raw.githubusercontent.com/notshekhar/squirm/main/install.sh | bash
#
# Layout after install:
#   $SQUIRM_HOME/             (default: ~/.squirm-bin)
#     ├── squirm              (standalone binary; no runtime dependencies)
#     └── package.json
#   $BIN_DIR/squirm → $SQUIRM_HOME/squirm   (symlink on PATH)
#
# Env knobs:
#   SQUIRM_REPO_SLUG  notshekhar/squirm    override repo
#   SQUIRM_VERSION    vX.Y.Z               pin a tag
#   SQUIRM_HOME       $HOME/.squirm-bin    install dir
#   SQUIRM_BIN_DIR                         symlink dir (auto-detected)
#   SQUIRM_FORCE      1                    skip "already up to date" gate
#   SQUIRM_UNINSTALL  1                    remove install + symlink and exit

set -euo pipefail

REPO_SLUG="${SQUIRM_REPO_SLUG:-notshekhar/squirm}"
SQUIRM_HOME="${SQUIRM_HOME:-$HOME/.squirm-bin}"
FORCE="${SQUIRM_FORCE:-0}"
UNINSTALL="${SQUIRM_UNINSTALL:-0}"
PIN_VERSION="${SQUIRM_VERSION:-}"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
dim()  { printf "\033[2m%s\033[0m\n" "$*"; }
err()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }

need_tool() { command -v "$1" >/dev/null 2>&1 || { err "Missing required tool: $1"; exit 1; }; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else err "missing sha256sum/shasum"; return 1; fi
}

ver_gt() {
  local a="${1#v}" b="${2#v}"
  [ "$a" = "$b" ] && return 1
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)" = "$b" ]
}

detect_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) err "Windows: download the binary from the Releases page."; exit 1 ;;
    *) err "unsupported OS: $(uname -s)"; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) err "unsupported arch: $(uname -m)"; exit 1 ;;
  esac
  printf "%s-%s" "$os" "$arch"
}

resolve_latest_tag() {
  local final tag
  final="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO_SLUG}/releases/latest" 2>/dev/null || true)"
  tag="${final##*/}"
  case "$tag" in v[0-9]*) printf "%s" "$tag" ;; esac
}

resolve_bin_dir() {
  if [ -n "${SQUIRM_BIN_DIR:-}" ]; then mkdir -p "$SQUIRM_BIN_DIR"; printf "%s" "$SQUIRM_BIN_DIR"; return; fi
  for d in /usr/local/bin /opt/homebrew/bin; do
    [ -w "$d" ] 2>/dev/null && { printf "%s" "$d"; return; }
  done
  local fallback="$HOME/.local/bin"; mkdir -p "$fallback"; printf "%s" "$fallback"
}

uninstall() {
  bold "▶ Uninstalling squirm"
  for link in "$HOME/.local/bin/squirm" "/usr/local/bin/squirm" "/opt/homebrew/bin/squirm" \
              "${SQUIRM_BIN_DIR:+$SQUIRM_BIN_DIR/squirm}"; do
    [ -n "$link" ] || continue
    { [ -L "$link" ] || [ -f "$link" ]; } && rm -f "$link" 2>/dev/null && dim "  removed $link" || true
  done
  rm -rf "$SQUIRM_HOME" 2>/dev/null && dim "  removed $SQUIRM_HOME" || true
  bold "✓ Uninstalled."
}

main() {
  [ "$UNINSTALL" = "1" ] && { uninstall; exit 0; }

  bold "▶ squirm installer"
  need_tool curl; need_tool tar

  local target latest installed
  target="$(detect_target)"
  dim "  target: $target"

  latest="${PIN_VERSION:-$(resolve_latest_tag)}"
  if [ -z "$latest" ]; then
    err "could not resolve latest release tag from $REPO_SLUG"
    err "set SQUIRM_VERSION=vX.Y.Z to pin a release"
    exit 1
  fi
  case "$latest" in v*) ;; *) latest="v$latest" ;; esac

  installed=""
  [ -f "$SQUIRM_HOME/package.json" ] && \
    installed="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SQUIRM_HOME/package.json" | head -n1 || true)"
  if [ "$FORCE" != "1" ] && [ -n "$installed" ] && ! ver_gt "${latest#v}" "${installed#v}"; then
    bold "✓ Up to date (installed $installed, latest $latest)"
    dim "  SQUIRM_FORCE=1 to reinstall"
    exit 0
  fi

  local scratch tar url base
  scratch="${SQUIRM_HOME}.new.$$"
  trap 'rm -rf "$scratch" 2>/dev/null || true' EXIT
  mkdir -p "$scratch"

  base="https://github.com/${REPO_SLUG}/releases/download/${latest}"
  url="${base}/squirm-${target}.tar.gz"
  tar="$scratch/squirm.tar.gz"

  bold "▶ Downloading ${url##*/}"
  curl -fL --progress-bar "$url" -o "$tar" || { err "download failed: $url"; exit 1; }

  if curl -fsSL "${url}.sha256" -o "$scratch/sum" 2>/dev/null && [ -s "$scratch/sum" ]; then
    local expected got
    expected="$(awk '{print $1}' "$scratch/sum")"
    got="$(sha256_of "$tar")"
    [ "$expected" = "$got" ] || { err "sha256 mismatch"; exit 1; }
    dim "  sha256 ok"
  fi

  bold "▶ Extracting"
  tar -xzf "$tar" -C "$scratch"
  [ -x "$scratch/$target/squirm" ] || { err "tarball missing $target/squirm"; exit 1; }

  if [ "$(uname -s)" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$scratch/$target" 2>/dev/null || true
  fi

  bold "▶ Installing to $SQUIRM_HOME"
  [ -e "$SQUIRM_HOME" ] && rm -rf "${SQUIRM_HOME}.old.$$" && mv "$SQUIRM_HOME" "${SQUIRM_HOME}.old.$$"
  mv "$scratch/$target" "$SQUIRM_HOME"
  rm -rf "${SQUIRM_HOME}.old.$$" 2>/dev/null || true
  trap - EXIT
  rm -rf "$scratch" 2>/dev/null || true

  local bin_dir; bin_dir="$(resolve_bin_dir)"
  ln -sf "$SQUIRM_HOME/squirm" "$bin_dir/squirm"
  hash -r 2>/dev/null || true

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) err "warning: $bin_dir is not on PATH — add it to your shell rc" ;;
  esac

  "$SQUIRM_HOME/squirm" --version >/dev/null 2>&1 || { err "installed binary failed to run"; exit 1; }
  bold "✓ Installed squirm $latest → $bin_dir/squirm"
}

main "$@"
