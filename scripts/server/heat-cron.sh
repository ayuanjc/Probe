#!/bin/bash
# 后台热度计算（PRD Phase 3 第 1 项）：把 30 天历史基线补齐，并强制重算一次热榜快照。
# 顺带喂关注实体（watches）与国内榜单缓存：一次 cron 干完三件事。
#
# 2026-10-26 修：站点从 /probe 搬到根之后，这里还打着 /probe/api/cron/heat，
# 每 30 分钟回 404、连挂 18 小时（热榜快照与关注命中全停）。
# 现在地址可覆盖，默认走根；换前缀不用再改脚本。
#
# 不配 secret 时端点自己 503，脚本只看返回码。
# 失败会重试两次（隔 10 秒）：更新时 probe-web 正在重启，第一次打过去常常连不上，
# 那不是数据源的问题，不该等到半小时后。
set -uo pipefail
SECRET="${PROBE_CRON_SECRET:-$(sed -n 's/^PROBE_CRON_SECRET=//p' /opt/probe/probe.env)}"
URL="${PROBE_HEAT_URL:-http://127.0.0.1:3215/api/cron/heat}"
LOG="${PROBE_HEAT_LOG:-/var/log/probe-heat.log}"

if [ -z "${SECRET}" ]; then
  echo "$(date -Is) skip: PROBE_CRON_SECRET 未配置" >> "${LOG}"
  exit 0
fi
for attempt in 1 2 3; do
  OUT="$(curl -sS -m 120 -X POST -H "x-probe-cron-secret: ${SECRET}" -w '\n%{http_code}' "${URL}" 2>/dev/null)"
  CODE="$(printf '%s' "${OUT}" | tail -n1)"
  BODY="$(printf '%s' "${OUT}" | sed '$d')"
  # 429 = 这一轮撞上端点自己的限流（PROBE_CRON_RATE_LIMIT_PER_MIN），等下一轮即可，不算故障。
  echo "$(date -Is) try=${attempt} http=${CODE} ${BODY}" >> "${LOG}"
  [ "${CODE}" = "200" ] && exit 0
  [ "${attempt}" = "3" ] && exit 1
  sleep 10
done
