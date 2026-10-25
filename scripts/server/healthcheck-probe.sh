#!/usr/bin/env bash
# Probe 存活探针（systemd: probe-health.timer，每 2 分钟）
#
# 只做「看得见」的检查是不够的：next start 会活着但返回 500，
# nginx 会活着但上游全断，磁盘会悄悄写满。这里逐项判，出问题先自愈
# （重启服务），还不行才告警 —— 半夜 rss 挂掉时，先救活比先吵醒人有意义。
#
# 告警通道：/opt/probe/probe.env 里设 PROBE_ALERT_WEBHOOK=<任意接受
# POST {"text": "..."} 的地址>（Server酱 / PushPlus / 钉钉机器人中转 / 自建都行）。
# 没配就只写日志 —— 别让「没配告警」变成一条静默的失败。
set -uo pipefail

# 探活地址可用 PROBE_HEALTH_URL 改（演练告警链路时指到死端口，不必真停线上服务）
APP_URL="${PROBE_HEALTH_URL:-http://127.0.0.1:3215/api/version}"
LOG=/var/log/probe-health.log
STATE_DIR=/run/probe-health
DEDUP_SECONDS=1800   # 同类告警半小时内只发一次

mkdir -p "$STATE_DIR" 2>/dev/null

# 读运行配置（PROBE_ALERT_WEBHOOK 等）。不 source 全部环境：只取白名单。
if [ -z "${PROBE_ALERT_WEBHOOK:-}" ] && [ -f /opt/probe/probe.env ]; then
  PROBE_ALERT_WEBHOOK=$(grep -E '^\s*PROBE_ALERT_WEBHOOK\s*=' /opt/probe/probe.env | tail -1 | sed -E 's/^[^=]*=\s*//; s/^["'\'']//; s/["'\'']\s*$//')
fi

log() { echo "$(date -Is) $*" >> "$LOG"; }

# 日志自己轮转：探针每 2 分钟一条，不轮转会无限长
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 2097152 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

alert() { # key 文案
  local key=$1 msg=$2
  local stamp_file="$STATE_DIR/$key"
  local now=$(date +%s)
  local last=0
  [ -f "$stamp_file" ] && last=$(cat "$stamp_file" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$DEDUP_SECONDS" ]; then
    log "ALERT(抑制) $msg"
    return 0
  fi
  echo "$now" > "$stamp_file"
  log "ALERT $msg"
  if [ -n "${PROBE_ALERT_WEBHOOK:-}" ]; then
    local payload
    payload=$(printf '{"text":"[探针] %s","msg":"%s","host":"%s"}' \
      "$(hostname)" "$msg" "$(date -Is)")
    if ! curl -fsS -m 8 -H 'Content-Type: application/json' \
         -d "$payload" "$PROBE_ALERT_WEBHOOK" > /dev/null 2>&1; then
      log "webhook 发送失败（$msg）"
    fi
  fi
}

ok_count=0
fail_count=0

# 1) 服务是否在跑
if systemctl is-active --quiet probe-web.service; then
  ok_count=$((ok_count + 1))
else
  fail_count=$((fail_count + 1))
  log "probe-web 不是 active，尝试重启"
  systemctl restart probe-web.service > /dev/null 2>&1
  sleep 8
  if systemctl is-active --quiet probe-web.service; then
    log "重启后已恢复"
    ok_count=$((ok_count + 1))
  else
    alert "service_down" "probe-web 重启后仍不是 active，站点不可用"
  fi
fi

# 2) 应用真的能回包吗（端口开着不代表能出结果）
body=$(curl -fsS -m 8 "$APP_URL" 2>/dev/null)
code=$?
if [ "$code" = "0" ] && printf %s "$body" | grep -q '"buildId"'; then
  ok_count=$((ok_count + 1))
else
  fail_count=$((fail_count + 1))
  alert "app_unhealthy" "$APP_URL 没有返回可用的 version 包（curl 退出码 $code）"
fi

# 3) 磁盘（写满会让 .data 写入失败 → 所有人登不上）
disk=$(df -P / | awk 'NR==2 {gsub("%", "", $5); print $5}')
if [ "${disk:-0}" -ge 90 ]; then
  fail_count=$((fail_count + 1))
  alert "disk_full" "根分区已用 ${disk}%，接近写满"
else
  ok_count=$((ok_count + 1))
fi

# 4) 内存（1.2G 上限的 node 进程在 4G 机器上，OOM 会先杀它）
avail=$(awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo)
if [ "${avail:-9999}" -lt 150 ]; then
  fail_count=$((fail_count + 1))
  alert "low_memory" "可用内存只剩 ${avail}MB"
else
  ok_count=$((ok_count + 1))
fi

# 5) 反复重启（Restart=always 会把崩溃藏起来：一直能访问，但一直在挂）
restarts=$(systemctl show probe-web.service -p NRestarts --value 2>/dev/null || echo 0)
last_restarts=$(cat "$STATE_DIR/restarts" 2>/dev/null || echo "$restarts")
delta=$((restarts - last_restarts))
echo "$restarts" > "$STATE_DIR/restarts"
if [ "$delta" -ge 3 ]; then
  alert "flapping" "probe-web 自上次检查以来重启了 $delta 次（累计 $restarts）"
fi

log "checked ok=$ok_count fail=$fail_count disk=${disk}% mem=${avail}MB restarts=${restarts}"
[ "$fail_count" -eq 0 ] || exit 1
exit 0
