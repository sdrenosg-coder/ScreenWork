#!/usr/bin/env bash
# Zipy AI — on-prem upgrade script.
#
# Performs the sequence documented in docs/operations/on-prem.md §4:
#   1. Back up Postgres (via scripts/backup-postgres.sh).
#   2. Fetch tags and check out the requested release.
#   3. npm ci.
#   4. npm run migrate (idempotent).
#   5. Reinstall Playwright browsers when the lockfile bumped Playwright.
#   6. Build.
#   7. Restart the worker first, then web.
#
# This script is deliberately conservative: it refuses to run when it cannot
# confirm every prerequisite, and it stops on the first failure. It does not
# attempt a rollback. The operator restores from the backup it produced
# when a step fails; step 1 is the safety net.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: upgrade.sh <release-tag>

  <release-tag>  A git tag, branch or commit that the repository can resolve.

Environment:
  ZIPY_REPO_DIR       Repository checkout (default: /opt/zipy)
  ZIPY_SERVICE_USER   Unprivileged user that owns the checkout (default: zipy)
  ZIPY_RUN_AS_ROOT    1 to run the privileged steps; default 1.

The script assumes /etc/zipy/zipy.env is the environment file. It does not
modify that file.
USAGE
}

if [[ $# -ne 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

release_tag="$1"
repo_dir="${ZIPY_REPO_DIR:-/opt/zipy}"
service_user="${ZIPY_SERVICE_USER:-zipy}"

as_service_user() {
  if [[ "$(id -un)" == "${service_user}" ]]; then
    "$@"
  else
    sudo -u "${service_user}" -- "$@"
  fi
}

if [[ ! -d "${repo_dir}/.git" ]]; then
  echo "upgrade.sh: ${repo_dir} is not a git checkout." >&2
  exit 1
fi

if [[ ! -f /etc/zipy/zipy.env ]]; then
  echo "upgrade.sh: /etc/zipy/zipy.env not found. Create it from env.example.onprem." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a
. /etc/zipy/zipy.env
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "upgrade.sh: DATABASE_URL is empty after loading /etc/zipy/zipy.env." >&2
  exit 1
fi

echo "upgrade.sh: step 1/7 — backing up Postgres"
"${repo_dir}/scripts/backup-postgres.sh"

echo "upgrade.sh: step 2/7 — fetching tags and checking out ${release_tag}"
as_service_user git -C "${repo_dir}" fetch --all --tags
as_service_user git -C "${repo_dir}" checkout "${release_tag}"

echo "upgrade.sh: step 3/7 — npm ci"
(
  cd "${repo_dir}"
  as_service_user npm ci
)

echo "upgrade.sh: step 4/7 — npm run migrate"
(
  cd "${repo_dir}"
  # Preserve DATABASE_URL through sudo -u when applicable.
  if [[ "$(id -un)" == "${service_user}" ]]; then
    npm run migrate
  else
    sudo -u "${service_user}" --preserve-env=DATABASE_URL npm run migrate
  fi
)

echo "upgrade.sh: step 5/7 — reinstall Playwright browsers when needed"
prev_playwright="$(as_service_user git -C "${repo_dir}" show HEAD~1:package-lock.json 2>/dev/null | grep -m1 '"playwright"' || true)"
next_playwright="$(grep -m1 '"playwright"' "${repo_dir}/package-lock.json" || true)"
if [[ "${prev_playwright}" != "${next_playwright}" ]]; then
  echo "  Playwright changed between releases; reinstalling."
  if [[ "$(id -un)" == "root" ]]; then
    "${repo_dir}/install-playwright-browsers.sh"
  else
    sudo "${repo_dir}/install-playwright-browsers.sh"
  fi
else
  echo "  Playwright unchanged; skipping."
fi

echo "upgrade.sh: step 6/7 — build"
(
  cd "${repo_dir}"
  as_service_user npm run build:all
)

echo "upgrade.sh: step 7/7 — restart worker, then web"
if [[ "$(id -un)" == "root" ]]; then
  systemctl restart zipy-worker
  systemctl restart zipy-web
  systemctl --no-pager --lines=0 status zipy-worker zipy-web || true
else
  sudo systemctl restart zipy-worker
  sudo systemctl restart zipy-web
  sudo systemctl --no-pager --lines=0 status zipy-worker zipy-web || true
fi

echo "upgrade.sh: done."
