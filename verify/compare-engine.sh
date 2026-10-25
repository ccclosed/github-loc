#!/usr/bin/env bash
# Независимая сверка: оракул (Python) vs движок (Node) на ОДНОМ И ТОМ ЖЕ tarball.
#
#   ./compare-engine.sh owner/repo [owner/repo ...]
#
# Для каждого репо: фиксируется commit (api.github.com), скачивается
# https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>, затем
#   python3 verify/oracle.py --file <tb> --no-meta --json-out ...
#   node tools/count-repo.mjs <tb> --json
# Сырые выводы: verify/raw/v2/{oracle,engine}-<owner>__<repo>.{json}
# Сводка-сравнение: verify/raw/v2/compare-<owner>__<repo>.txt + compare-summary.txt
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # github-loc/

OUT=verify/raw/v2
TMP=${TMPDIR:-/tmp}/ghloc-verify
mkdir -p "$OUT" "$TMP"
: > "$OUT/compare-summary.txt"

for repo in "$@"; do
  safe="${repo//\//__}"
  echo "================ $repo ================" | tee -a "$OUT/compare-summary.txt"

  branch=$(curl -sS "https://api.github.com/repos/$repo" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("default_branch","main"))')
  sha=$(curl -sS "https://api.github.com/repos/$repo/commits/$branch" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("sha",""))')
  tb="$TMP/$safe@$sha.tar.gz"
  echo "ref=$branch commit=$sha" | tee -a "$OUT/compare-summary.txt"

  if [[ ! -s "$tb" ]]; then
    curl -sSL "https://codeload.github.com/$repo/tar.gz/$sha" -o "$tb" || { echo "DOWNLOAD FAILED" | tee -a "$OUT/compare-summary.txt"; continue; }
  fi
  echo "tarball=$tb $(stat -c%s "$tb") bytes sha256=$(sha256sum "$tb" | cut -c1-16)" | tee -a "$OUT/compare-summary.txt"

  python3 verify/oracle.py --file "$tb" --no-meta --json-out "$OUT/oracle-$safe.json" \
    > "$OUT/oracle-$safe.log" 2>&1
  echo "oracle rc=$? -> $OUT/oracle-$safe.json" | tee -a "$OUT/compare-summary.txt"

  node tools/count-repo.mjs "$tb" --json > "$OUT/engine-$safe.json" 2> "$OUT/engine-$safe.err"
  echo "engine rc=$? -> $OUT/engine-$safe.json" | tee -a "$OUT/compare-summary.txt"

  python3 verify/compare-json.py "$OUT/oracle-$safe.json" "$OUT/engine-$safe.json" \
    --label "$repo" | tee "$OUT/compare-$safe.txt"
  cat "$OUT/compare-$safe.txt" >> "$OUT/compare-summary.txt"
  echo | tee -a "$OUT/compare-summary.txt"
done