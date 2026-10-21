#!/usr/bin/env bash
OUT=$1
echo "epoch_ms,container,cpu_pct,mem_usage,net_io,block_io" > "$OUT"
while true; do
  ts=$(date +%s%3N)
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}},{{.BlockIO}}' \
    | sed "s/^/$ts,/" >> "$OUT"
  sleep 1
done
