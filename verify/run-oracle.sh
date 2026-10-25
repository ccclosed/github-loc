#!/usr/bin/env bash
# Обёртка независимого оракула.
#
#   ./run-oracle.sh <owner/repo> [ref] [доп. аргументы oracle.py]
#
# Результат: verify/out/<owner>__<repo>.json (+ лог в verify/raw/oracle-<owner>__<repo>.log)
# Примеры:
#   ./run-oracle.sh octocat/Spoon-Knife
#   ./run-oracle.sh rust-lang/rustlings master
#   ./run-oracle.sh pallets/flask main --ignore-profile extended
#   ./run-oracle.sh owner/repo --max-archive-mb 0          # без лимита сжатого архива
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORACLE="$HERE/oracle.py"
OUTDIR="$HERE/out"
RAWDIR="$HERE/raw"
PY="${PYTHON:-python3}"

if [[ $# -lt 1 ]]; then
  echo "использование: $0 <owner/repo> [ref] [доп. аргументы oracle.py]" >&2
  exit 64
fi

REPO="$1"; shift
REF=""
if [[ $# -gt 0 && "$1" != --* ]]; then
  REF="$1"; shift
fi

if [[ "$REPO" != */* ]]; then
  echo "репозиторий задаётся как owner/repo (получено: $REPO)" >&2
  exit 64
fi

SAFE="${REPO//\//__}"
mkdir -p "$OUTDIR" "$RAWDIR"
JSON="$OUTDIR/$SAFE.json"
LOG="$RAWDIR/oracle-$SAFE.log"

echo "[run-oracle] $REPO ${REF:-<default_branch>} → $JSON" >&2
set +e
"$PY" "$ORACLE" "$REPO" ${REF:+"$REF"} --json-out "$JSON" "$@" 2> "$LOG"
RC=$?
set -e
cat "$LOG" >&2
echo "[run-oracle] rc=$RC, json: $JSON, лог: $LOG" >&2
exit "$RC"