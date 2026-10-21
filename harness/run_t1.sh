#!/usr/bin/env bash
set -u
RUNS=${1:-5}; ITERS=${2:-60}; WARMUP=${3:-3}; CONFIG=${4:-bt2s}
cd "$(dirname "$0")"
for r in $(seq 1 "$RUNS"); do
  DIR=../results/T1/$CONFIG/r$r
  mkdir -p "$DIR"
  echo "===== T1 $CONFIG run $r/$RUNS ====="
  ./storage.sh > "$DIR/storage_before.csv"
  ./monitor.sh "$DIR/resources.csv" & MON=$!
  node t1.js --run "$r" --iters "$ITERS" --warmup "$WARMUP" --config "$CONFIG" --out "$DIR"
  kill "$MON" 2>/dev/null; wait "$MON" 2>/dev/null
  ./storage.sh > "$DIR/storage_after.csv"
done
echo "T1 $CONFIG completed."
