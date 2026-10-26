#!/bin/sh
# 压测时采 Node 主进程的每秒 CPU% 与 RSS。
#
#   /tmp/sample.sh <pid> <秒数>
#
# 注意 /proc/<pid>/stat 的 comm 是 "next-server (v16.4.2)"，里面带空格，
# awk 按空白切词后字段整体右移一位：utime/stime 变成 $15/$16，rss 变成 $25。
# 用 $14/$15 会把 cmajflt 当成 CPU 算进去，用 $24 会读出一个天文数字的内存。
#
# 取 pid：ps -eo pid,args | grep next-server（pgrep -f 在非交互 ssh shell 里有时取不到，
# 取不到时本脚本会输出一排 cpu=0% rss=0kb —— 那是没采到，不是真的 0）。
PID=$1
N=${2:-40}
if [ -z "$PID" ] || [ ! -r "/proc/$PID/stat" ]; then
  echo "用法：$0 <pid> <秒数>（pid 为空或 /proc/PID/stat 不可读）" >&2
  exit 2
fi
i=0
prev=$(awk '{print $15+$16}' /proc/$PID/stat)
while [ $i -lt $N ]; do
  sleep 1
  cur=$(awk '{print $15+$16}' /proc/$PID/stat)
  echo "t=${i}s cpu=$((cur-prev))% rss=$(ps -p $PID -o rss=)kb load=$(cut -d' ' -f1 /proc/loadavg)"
  prev=$cur
  i=$((i+1))
done
