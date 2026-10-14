#!/usr/bin/env bash
# Zipy AI — invoke a scheduled job on the on-prem host.
#
# docs/operations/on-prem.md §6 lists the job kinds the platform expects the
# operator to schedule. This wrapper enqueues the job through the worker
# CLI when the operator's build ships one; otherwise it calls the same
# public API the web application uses with a service session cookie the
# operator supplies in ZIPY_SERVICE_COOKIE.
#
# Exit codes:
#   0  job enqueued or the CLI reported success
#   1  the job kind is missing or a prerequisite is not configured

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: run-job.sh <job-kind>

Job kinds the platform schedules:
  retention:sweep
  lifecycle:recurring
  analytics:rollup
  quality:regression

Environment:
  ZIPY_REPO_DIR          Repository checkout (default: /opt/zipy)
  ZIPY_SERVICE_USER      Owner of the checkout (default: zipy)
  PUBLIC_BASE_URL        Used when falling back to the HTTP path.
  ZIPY_SERVICE_COOKIE    Session cookie for the HTTP fallback. Required
                         only when the CLI is not present in the build.
USAGE
}

if [[ $# -ne 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

job_kind="$1"
repo_dir="${ZIPY_REPO_DIR:-/opt/zipy}"
service_user="${ZIPY_SERVICE_USER:-zipy}"

case "${job_kind}" in
  retention:sweep|lifecycle:recurring|analytics:rollup|quality:regression) ;;
  *)
    echo "run-job.sh: unknown job kind '${job_kind}'. See usage." >&2
    exit 1
    ;;
esac

# Preferred path: the worker's CLI, when the build produced one. The CLI
# enqueues the job directly through the queue module and does not need a
# session cookie.
cli_path="${repo_dir}/apps/worker/dist/cli/run-job.js"
if [[ -f "${cli_path}" ]]; then
  if [[ "$(id -un)" == "${service_user}" ]]; then
    exec node "${cli_path}" "${job_kind}"
  else
    exec sudo -u "${service_user}" --preserve-env=DATABASE_URL node "${cli_path}" "${job_kind}"
  fi
fi

# Fallback: the HTTP API. This requires a session cookie for an account
# with the permission to enqueue the job kind. The operator is expected to
# provision a service account and supply its cookie via ZIPY_SERVICE_COOKIE.
if [[ -z "${PUBLIC_BASE_URL:-}" || -z "${ZIPY_SERVICE_COOKIE:-}" ]]; then
  echo "run-job.sh: no CLI in the build, and PUBLIC_BASE_URL / ZIPY_SERVICE_COOKIE are not both set." >&2
  echo "Build the worker CLI, or provision a service account cookie and set both variables." >&2
  exit 1
fi

endpoint="${PUBLIC_BASE_URL%/}/api/v1/jobs"
body="$(printf '{"kind":"%s"}' "${job_kind}")"

http_status="$(curl -sS -o /tmp/zipy-run-job.out -w '%{http_code}' \
  -X POST "${endpoint}" \
  -H 'content-type: application/json' \
  -H "cookie: ${ZIPY_SERVICE_COOKIE}" \
  --data "${body}")"

if [[ "${http_status}" -lt 200 || "${http_status}" -ge 300 ]]; then
  echo "run-job.sh: POST ${endpoint} returned HTTP ${http_status}." >&2
  sed 's/^/  /' /tmp/zipy-run-job.out >&2 || true
  exit 1
fi

echo "run-job.sh: ${job_kind} accepted (HTTP ${http_status})."
sed 's/^/  /' /tmp/zipy-run-job.out || true
