#!/bin/bash
# Phase 0 prototype: cost of docker exec per run vs a resident process. Throwaway containers only.
set -u
IMG=judge-py-env; N=${N:-200}; P=${P:-10}
cpu() { awk '/^cpu /{print $2+$3+$4+$6+$7+$8}' /proc/stat; }   # busy jiffies, all cores
mk() { docker run -d --rm --name "$1" --network none --read-only --cap-drop ALL --cap-add KILL \
  --security-opt no-new-privileges --pids-limit 256 --memory 1g \
  --tmpfs /app:rw,exec,mode=1777 --tmpfs /tmp:rw,exec,mode=1777 "$IMG" tail -f /dev/null >/dev/null; }
for i in $(seq 1 $P); do mk bench$i; done
JU=judge; docker exec bench1 id $JU >/dev/null 2>&1 || JU=nobody
SRC='n=int(input())\nprint(n*2)'
today() { c=$1; k=$2
  printf "$SRC" | docker exec -i -u $JU -w / $c sh -c "mkdir -p /app/s$k && cat > /app/s$k/m.py" &&
  echo 21 | docker exec -i -u $JU -w /app/s$k $c python3 m.py >/dev/null &&
  docker exec -u root $c sh -c 'pkill -9 -u '$JU' || true' &&
  docker exec -u $JU $c sh -c 'rm -rf /app/* /tmp/* 2>/dev/null; true'; }
merged() { c=$1; k=$2
  printf "$SRC" | docker exec -i -u $JU $c sh -c "rm -rf /app/* /tmp/* 2>/dev/null; mkdir -p /app/s$k && cat > /app/s$k/m.py && cd /app/s$k && echo 21 | python3 m.py" >/dev/null &&
  docker exec -u root $c sh -c 'pkill -9 -u '$JU' || true'; }
run() { name=$1; fn=$2; per=$((N/P)); c0=$(cpu); t0=$(date +%s%N)
  for i in $(seq 1 $P); do ( for k in $(seq 1 $per); do $fn bench$i $k || echo FAIL; done ) & done; wait
  t1=$(date +%s%N); c1=$(cpu); ms=$(( (t1-t0)/1000000 ))
  printf "%-26s %5d runs  %6d ms  %6.1f runs/s  host CPU %5.1f ms/run\n" "$name" $N $ms $(echo "$N*1000/$ms" | bc -l) $(echo "($c1-$c0)*10/$N" | bc -l); }
resident() { per=$((N/P)); c0=$(cpu); t0=$(date +%s%N)
  for i in $(seq 1 $P); do
    # One long-lived exec per container reads jobs from stdin and does upload+run+wipe itself.
    ( for k in $(seq 1 $per); do echo $k; done | docker exec -i -u $JU bench$i sh -c 'while read k; do rm -rf /app/* /tmp/* 2>/dev/null; mkdir -p /app/s$k; printf "n=int(input())\nprint(n*2)" > /app/s$k/m.py; (cd /app/s$k && echo 21 | python3 m.py) >/dev/null; done' ) &
  done; wait
  t1=$(date +%s%N); c1=$(cpu); ms=$(( (t1-t0)/1000000 ))
  printf "%-26s %5d runs  %6d ms  %6.1f runs/s  host CPU %5.1f ms/run\n" "resident (no exec per run)" $N $ms $(echo "$N*1000/$ms" | bc -l) $(echo "($c1-$c0)*10/$N" | bc -l); }
echo "host: $(lscpu | grep 'Model name' | sed 's/.*: *//'), $P containers, $N runs, user $JU"
run "today (4 execs/run)" today
run "phase 1 (2 execs/run)" merged
resident
for i in $(seq 1 $P); do docker rm -f bench$i >/dev/null; done
