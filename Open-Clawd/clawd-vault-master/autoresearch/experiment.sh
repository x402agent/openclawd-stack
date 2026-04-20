#!/usr/bin/env bash
# Run a single experiment iteration
# Usage: ./autoresearch/experiment.sh "description of what was changed"
set -euo pipefail

DESC="${1:-no description}"
RESULTS="autoresearch/results.tsv"

cd "$(git rev-parse --show-toplevel)"

# 1. Build
echo "Building..."
if ! npm run build 2>&1 | tail -3; then
  COMMIT=$(git rev-parse --short HEAD)
  echo -e "${COMMIT}\t0.0\t0.0\t0.0\t0.0\t0.0\tcrash\t${DESC} (build failed)" >> "$RESULTS"
  echo "BUILD FAILED"
  exit 1
fi

# 2. Quick test (just observer + benchmark tests, not full suite)
echo "Running quick tests..."
if ! npx vitest run src/observer/ src/commands/benchmark 2>&1 | tail -5; then
  COMMIT=$(git rev-parse --short HEAD)
  echo -e "${COMMIT}\t0.0\t0.0\t0.0\t0.0\t0.0\tcrash\t${DESC} (tests failed)" >> "$RESULTS"
  echo "TESTS FAILED"
  exit 1
fi

# 3. Benchmark with Gemini
echo "Running benchmark (Gemini)..."
if ! npx clawvault benchmark observer --provider gemini --report-format json > autoresearch/run-latest.json 2>&1; then
  COMMIT=$(git rev-parse --short HEAD)
  echo -e "${COMMIT}\t0.0\t0.0\t0.0\t0.0\t0.0\tcrash\t${DESC} (benchmark failed)" >> "$RESULTS"
  echo "BENCHMARK FAILED"
  exit 1
fi

# 4. Extract scores
SCORES=$(python3 -c "
import json
with open('autoresearch/run-latest.json') as f:
    d = json.load(f)
m = d['aggregate']
print(f\"{m['overall']:.1f}\t{m['precision']:.1f}\t{m['recall']:.1f}\t{m['keywordPreservation']:.1f}\t{m['typeAccuracy']:.1f}\")
")

OVERALL=$(echo "$SCORES" | cut -f1)
COMMIT=$(git rev-parse --short HEAD)

# 5. Compare to previous best
PREV_BEST=$(tail -n +2 "$RESULTS" | grep "keep" | awk -F'\t' '{print $2}' | sort -rn | head -1)
PREV_BEST=${PREV_BEST:-0.0}

echo "Result: overall=$OVERALL (previous best: $PREV_BEST)"

if python3 -c "exit(0 if float('$OVERALL') > float('$PREV_BEST') else 1)" 2>/dev/null; then
  echo -e "${COMMIT}\t${SCORES}\tkeep\t${DESC}" >> "$RESULTS"
  echo "✅ KEEP — new best: $OVERALL"
else
  echo -e "${COMMIT}\t${SCORES}\tdiscard\t${DESC}" >> "$RESULTS"
  echo "❌ DISCARD — no improvement ($OVERALL <= $PREV_BEST)"
  echo "Reverting..."
  git reset --hard HEAD~1
fi

echo "---"
cat "$RESULTS" | column -t -s$'\t' | tail -5
