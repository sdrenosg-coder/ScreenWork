#!/usr/bin/env bash
# Zipy AI — install Playwright browser binaries on an on-prem worker host.
#
# The repository pins Playwright in the worker workspace's manifest. The
# browser binaries themselves are large and are not committed. This script
# installs the binary for the browser the worker is configured to launch
# (`PLAYWRIGHT_BROWSER`), and—when the host permits—its shared-library
# dependencies.
#
# It is intentionally narrow: it installs exactly the browser the worker
# will launch, plus a WebKit-only fallback note when the operator switches
# browser kind later. It does not install node dependencies (that is
# `npm ci`), it does not run migrations, and it does not start any service.
#
# Environment:
#   PLAYWRIGHT_BROWSER       chromium (default) | firefox | webkit; must
#                            match the worker's PLAYWRIGHT_BROWSER.
#   PLAYWRIGHT_INSTALL_ALL   1 to install all three browsers regardless.
#   PLAYWRIGHT_SKIP_DEPS     1 to install binaries only (no OS packages).
#
# Exit codes:
#   0  success
#   1  precondition not met (no package-lock, missing npx, unknown browser)
#   2  a system library is missing after the install and cannot be installed

set -euo pipefail

log()  { printf 'install-playwright-browsers: %s\n' "$*" >&2; }
die()  { printf 'install-playwright-browsers: %s\n' "$*" >&2; exit "${2:-1}"; }

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

if [[ ! -f package-lock.json ]]; then
  die "package-lock.json not found at ${repo_root}. Run \`npm ci\` from the repository root first."
fi

if ! command -v npx >/dev/null 2>&1; then
  die "npx is not on PATH. Install Node.js 20+ and re-run."
fi

if ! command -v node >/dev/null 2>&1; then
  die "node is not on PATH. Install Node.js 20+ and re-run."
fi

# Determine whether we need sudo for the --with-deps step. When the user is
# already root, sudo is unnecessary; when sudo is not present and we are not
# root, only the binaries can be installed.
if [[ "${EUID}" -eq 0 ]]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  SUDO=""
  if [[ "${PLAYWRIGHT_SKIP_DEPS:-0}" != "1" ]]; then
    log "not root and sudo is unavailable: installing binaries only."
    log "re-run as root (or install the OS libraries manually) if a browser fails to launch."
    PLAYWRIGHT_SKIP_DEPS=1
  fi
fi

install_one() {
  local browser="$1"
  local deps_flag=()
  if [[ "${PLAYWRIGHT_SKIP_DEPS:-0}" != "1" ]]; then
    deps_flag=(--with-deps)
  fi
  log "installing ${browser} (${deps_flag[*]:-no deps})…"
  # npx --no-install ensures we use the Playwright pinned in this checkout,
  # not a globally-installed copy that may be a different version.
  # shellcheck disable=SC2086
  ${SUDO} npx --no-install playwright install "${deps_flag[@]}" "${browser}"
}

if [[ "${PLAYWRIGHT_INSTALL_ALL:-0}" == "1" ]]; then
  for b in chromium firefox webkit; do
    install_one "$b"
  done
else
  browser="${PLAYWRIGHT_BROWSER:-chromium}"
  case "${browser}" in
    chromium|firefox|webkit) install_one "${browser}" ;;
    *) die "PLAYWRIGHT_BROWSER must be chromium|firefox|webkit (got '${browser}')." 1 ;;
  esac
fi

# Playwright's own version is echoed so the operator can correlate a broken
# launch with a version drift on the host.
playwright_version="$(node -e "try{console.log(require('playwright/package.json').version)}catch(e){process.exit(0)}" 2>/dev/null || true)"
if [[ -n "${playwright_version}" ]]; then
  log "playwright version: ${playwright_version}"
fi

log "done. The worker launches the browser directly over CDP; no separate driver is required."
log "if a launch fails with a missing library, the worker prints the exact library name."
