#!/usr/bin/env bash
# ClawVault Autoresearch Runner
# Karpathy-style continuous experiment loop
# Usage: ./autoresearch/run.sh [tag]
set -euo pipefail

TAG="${1:-mar11}"
BRANCH="autoresearch/$TAG"
RESULTS="autoresearch/results.tsv"
LOG="autoresearch/research-log.md"
RUN_COUNT=0
BEST_OVERALL=0

cd "$(git rev-parse --show-toplevel)"

# Setup
if ! git rev-parse --verify "$BRANCH" &>/dev/null; then
  git checkout -b "$BRANCH"
  echo "Created branch $BRANCH"
else
  git checkout "$BRANCH"
  echo "Resumed branch $BRANCH"
fi

# Init results if needed
if [ ! -f "$RESULTS" ]; then
  echo -e "commit\toverall\tprecision\trecall\tkeyword\ttype_accuracy\tstatus\tdescription" > "$RESULTS"
fi

# Build
echo "Building..."
npm run build 2>&1 | tail -3

# Baseline
echo "Running baseline benchmark..."
npx clawvault benchmark observer --provider gemini --report-format json > autoresearch/run-latest.json 2>&1

SCORES=$(python3 -c "
import json
with open('autoresearch/run-latest.json') as f:
    d = json.load(f)
m = d['aggregate']
print(f\"{m['overall']:.1f}\t{m['precision']:.1f}\t{m['recall']:.1f}\t{m['keywordPreservation']:.1f}\t{m['typeAccuracy']:.1f}\")
")
OVERALL=$(echo "$SCORES" | cut -f1)
COMMIT=$(git rev-parse --short HEAD)
echo -e "${COMMIT}\t${SCORES}\tkeep\tbaseline" >> "$RESULTS"
BEST_OVERALL=$OVERALL

echo "Baseline: overall=$OVERALL"
echo "Starting experiment loop. Target: 95%+"
echo "---"

# The experiment loop is driven by the AI agent via the agent CLI
# This script just provides the harness. The agent calls:
#   ./autoresearch/experiment.sh "description of change"
# after making code changes, and it handles build/benchmark/keep-or-discard
echo "Harness ready. Agent should call ./autoresearch/experiment.sh after each code change."
