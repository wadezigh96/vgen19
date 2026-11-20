#!/usr/bin/env bash
#
# run-cycle.sh - run one scheduled Vgen19 mining cycle.
#
# The scheduler (installed by the main agent from scripts/schedule.json)
# calls this script; it is also runnable by hand for a manual dry cycle:
#   bash scripts/run-cycle.sh
#
# What it does:
#   1. Resolves the repo root from its own location and uses the data
#      dir from VGEN19_DATA_DIR (default: <repo-root>/data).
#   2. Takes a non-blocking `flock` on <data-dir>/runs/run-cycle.lock.
#      If another cycle holds it, this run skips cleanly (exit 0) and
#      logs that: two overlapping cycles would lose each other's
#      memory-store records (read-modify-write) and could both pass
#      the per-market cap check before either records, exceeding the
#      3-per-market cap.
#   3. Builds (npm run build) only if dist/cli.js is missing. The main
#      agent builds once at install time; this is a safety net, not
#      the normal path.
#   4. Fetches FRESH credential surrogates from authd at run start
#      (scripts/fetch-surrogate.py) and passes them as GEMINI_API_KEY
#      and TAVILY_API_KEY in the child process environment only, for
#      that run. The real keys live in the Muse Secure Vault and are
#      NEVER in a file or an environment variable: the runtime swaps
#      each hsurr: surrogate for the real key on egress to the
#      registered host. Surrogates are never echoed, never written to
#      a file or a log, and unset after the run.
#   5. Runs one mining cycle and captures its stdout/stderr to a
#      per-run log file under <data-dir>/runs/<cycle-id>.log. The
#      cycle runs under a hard 60-minute `timeout` (a backstop above
#      the runner's own 45-minute time budget) when `timeout` exists.
#   6. Refreshes the running summary (`vgen19 summary`, a local
#      aggregation needing no credentials) so a standing summary
#      exists after each cycle. Best-effort: its failure warns and
#      never fails the script or the cycle.
#   7. Appends one line to <data-dir>/runs/index.jsonl
#      ({ cycleId, startedAt, finishedAt, exitCode, status, logPath })
#      so the final summary can report failed cycles.
#
# Exit code: 0 unless the script cannot start at all (missing repo,
# missing node/python3, build failure, surrogate fetch failure). A
# FAILED CYCLE NEVER FAILS THIS SCRIPT: the failure is logged and
# recorded, and the script still exits 0, so the scheduler keeps
# running later cycles.
#
# NOTE: generating content through the Gemini surrogate path is
# untested (only list-models is verified through that connector), so
# the first scheduled run must be watched and its log checked.
#
# Never add `set -x` or echo the environment here: the per-run log
# must never contain a surrogate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# The data dir: absolute, so the log path recorded in the index is
# absolute too. A relative VGEN19_DATA_DIR resolves against the repo
# root (the agent process runs from here as well).
DATA_DIR="${VGEN19_DATA_DIR:-$REPO_ROOT/data}"
case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR="$REPO_ROOT/$DATA_DIR" ;;
esac
RUNS_DIR="$DATA_DIR/runs"
mkdir -p "$RUNS_DIR"

# Mutual exclusion: only one cycle runs at a time (see the header
# note). The lock lives on file descriptor 9 and is released when
# this script exits. When `flock` is unavailable the script runs
# without a lock; that is a degraded setup, not a fatal one.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$RUNS_DIR/run-cycle.lock"
  if ! flock -n 9; then
    echo "cycle skipped: another cycle is already running (lock $RUNS_DIR/run-cycle.lock is held)." >&2
    exit 0
  fi
fi

# Cannot start at all: fail loudly, non-zero.
if [ ! -f "$SCRIPT_DIR/fetch-surrogate.py" ]; then
  echo "error: cannot find $SCRIPT_DIR/fetch-surrogate.py; is this the vgen19 repo?" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not installed; cannot run a mining cycle." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is not installed; cannot fetch credential surrogates." >&2
  exit 1
fi

# Build only when the compiled CLI is missing (see the header note).
if [ ! -f "$REPO_ROOT/dist/cli.js" ]; then
  echo "dist/cli.js is missing; building..." >&2
  npm run build
fi

# The cycle id is second-granular plus this process's PID and a
# random suffix, so two runs can never share an id (and overwrite
# each other's log/trace/report/cost record or share one per-cycle
# cap bucket), even if they start within the same second.
CYCLE_ID="cycle-$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$-$RANDOM"
LOG_FILE="$RUNS_DIR/$CYCLE_ID.log"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Fetch fresh surrogates for this run only. A fetch failure means the
# cycle cannot run at all: exit non-zero naming the credential.
if ! GEMINI_SURROGATE="$(python3 "$SCRIPT_DIR/fetch-surrogate.py" custom.gemini)"; then
  echo "error: failed to fetch the Gemini credential surrogate (custom.gemini); the cycle did not run." >&2
  exit 1
fi
if ! TAVILY_SURROGATE="$(python3 "$SCRIPT_DIR/fetch-surrogate.py" custom.tavily)"; then
  echo "error: failed to fetch the Tavily credential surrogate (custom.tavily); the cycle did not run." >&2
  exit 1
fi

# OPTIONAL OpenRouter fallback (disabled): scheduled runs currently
# run WITHOUT the OpenRouter fallback — a Gemini outage kills the
# cycle. To add it, connect an OpenRouter credential in the vault
# first, then uncomment this block, add
# OPENROUTER_API_KEY="$OPENROUTER_SURROGATE" to the `node dist/cli.js
# mine` invocation below, and unset OPENROUTER_SURROGATE with the
# other surrogates. Do NOT uncomment it before the connection
# exists: fetching a surrogate for a connection that does not exist
# fails the run.
# if ! OPENROUTER_SURROGATE="$(python3 "$SCRIPT_DIR/fetch-surrogate.py" custom.openrouter)"; then
#   echo "error: failed to fetch the OpenRouter credential surrogate (custom.openrouter); the cycle did not run." >&2
#   exit 1
# fi

# Run the cycle under a hard 60-minute timeout: a backstop above the
# runner's own per-cycle time budget (45 minutes by default), so a
# hung cycle cannot block the scheduler forever. When `timeout` is
# unavailable, the cycle runs bare. Its exit code is captured, never
# fatal: a failed cycle is logged and reported, and this script
# still exits 0.
TIMEOUT_CMD=()
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout 60m)
fi
set +e
GEMINI_API_KEY="$GEMINI_SURROGATE" TAVILY_API_KEY="$TAVILY_SURROGATE" \
  "${TIMEOUT_CMD[@]}" node dist/cli.js mine --cycle "$CYCLE_ID" >"$LOG_FILE" 2>&1
EXIT_CODE=$?
set -e
unset GEMINI_SURROGATE TAVILY_SURROGATE

# Refresh the running summary (SPEC: one report per cycle plus a
# running summary). Best-effort: it needs no credentials and its
# failure must never fail the script or the cycle — warn and move on.
if ! node dist/cli.js summary >>"$LOG_FILE" 2>&1; then
  echo "warning: vgen19 summary failed after cycle $CYCLE_ID; the running summary was not refreshed." >&2
fi

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$EXIT_CODE" -eq 0 ]; then
  STATUS="ok"
else
  STATUS="failed"
fi

# Record the run for the final summary. A failed append must not
# fail the script: the log file still exists, and the next cycle
# must not be blocked by bookkeeping.
python3 - "$RUNS_DIR/index.jsonl" "$CYCLE_ID" "$STARTED_AT" "$FINISHED_AT" "$EXIT_CODE" "$STATUS" "$LOG_FILE" <<'PYEOF' || echo "warning: failed to append to $RUNS_DIR/index.jsonl" >&2
import json
import sys

index_path, cycle_id, started_at, finished_at, exit_code, status, log_path = sys.argv[1:8]
entry = {
    "cycleId": cycle_id,
    "startedAt": started_at,
    "finishedAt": finished_at,
    "exitCode": int(exit_code),
    "status": status,
    "logPath": log_path,
}
with open(index_path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(entry) + "\n")
PYEOF

if [ "$STATUS" = "ok" ]; then
  echo "cycle $CYCLE_ID completed; log: $LOG_FILE"
else
  echo "cycle $CYCLE_ID failed with exit code $EXIT_CODE; see $LOG_FILE" >&2
  echo "cycle $CYCLE_ID failed with exit code $EXIT_CODE; see $LOG_FILE"
fi
exit 0
