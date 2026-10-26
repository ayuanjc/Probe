#!/usr/bin/env bash
# 备案开工前的体检：只读，不改任何配置，不重启服务。
# 用法：/opt/probe/bin/beian-preflight.sh
# 退出码：0 = 没有 FAIL（WARN 可以带着往下走）；1 = 有 FAIL，先修。
set -uo pipefail
export PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

APP=/opt/probe/app
ENVF=/opt/probe/probe.env
DOMAIN=ayuanjc.online
IP=106.52.116.164
PORT=3215

fail=0; warn=0
ok()   { printf "  [PASS] %s\n" "$*"; }
bad()  { printf "  [FAIL] %s\n" "$*"; fail=$((fail+1)); }
note() { printf "  [WARN] %s\n" "$*"; warn=$((warn+1)); }
sect() { printf "\n%s\n" "$*"; }

code() { curl -s -o /dev/null -m 8 -w "%{http_code}" -H "Host: $1" "http://127.0.0.1$2"; }
codeip() { curl -s -o /dev/null -m 8 -w "%{http_code}" "http://127.0.0.1$1"; }

sect "0. 当前部署"
printf "  sha=%s build=%s\n" "$(cut -c1-12 /opt/probe/deployed-sha 2>/dev/null)" "$(cat "$APP/.next/BUILD_ID" 2>/dev/null)"
if systemctl is-active --quiet probe-web; then ok "probe-web active"; else bad "probe-web 不是 active"; fi

sect "1. 域名解析（首次备案审核期应当没有 A 记录）"
if getent hosts "$DOMAIN" | grep -q "$IP"; then
  note "$DOMAIN 仍解析到 $IP —— 订单还在审核的话，DNSPod 里把这条 A 记录停用"
else
  ok "$DOMAIN 当前不解析（符合审核期要求）"
fi

sect "2. 80 端口上谁在当 default_server"
DUPS=$(nginx -T 2>/dev/null | grep -c "listen .*80 default_server")
if nginx -T 2>/dev/null | grep -q "sites-enabled/probe-temp-open"; then
  bad "probe-temp-open 还在生效（裸 IP / 任意 Host 都能打开站点）—— 审核期必须撤掉"
else
  ok "probe-temp-open 未生效"
fi
if nginx -T 2>/dev/null | grep -q "sites-enabled/probe-root"; then
  note "probe-root 在生效（域名通道开着；审核期应当只有 probe-block）"
else
  ok "probe-root 未生效"
fi
[ "$DUPS" -ge 1 ] && ok "default_server 存在（$DUPS 条 listen）" || note "没有 default_server 兜底，陌生 Host 会落到第一个 server 块"

sect "3. 陌生 Host / 裸 IP（审核口径：域名撤了就不能再用任何 Host 拿到站点）"
IPC=$(code "$IP" "/"); IPC=${IPC:-000}
OTH=$(curl -s -o /dev/null -m 8 -w "%{http_code}" -H "Host: not-my-domain.example" "http://127.0.0.1/")
case "$IPC" in 000|444) ok "裸 IP -> $IPC（不可访问）";; *) note "裸 IP 仍可访问（$IPC）—— 只要只认 IP 字面量、陌生 Host 444，就不是驳回点";; esac
case "$OTH" in 000|444) ok "陌生 Host -> $OTH（掐断）";; *) bad "陌生 Host 仍能拿到站点（$OTH）：关掉解析后换 Host 还能访问，必驳回";; esac

sect "4. 站点内容（走当前真正在服务的那个 Host 自测）"
# 审核期域名通道是关的，内容页要从裸 IP 这一路验；两路都关才算异常。
DC=$(code "$DOMAIN" "/")
case "$DC" in 000|444) ok "域名通道 $DC（审核期应当如此）";; *) note "域名通道仍开着（$DC）—— 撤了解析后还能访问会被驳回";; esac
if [ "$IPC" = "000" ] || [ "$IPC" = "444" ]; then
  note "域名与裸 IP 都不通，跳过内容页检查（备案通过后 reopen 再跑一次）"
else
  for p in /privacy /terms /terms/en /check /entities; do
    c=$(code "$IP" "$p")
    if [ "$c" = "200" ]; then ok "$p -> 200"; else bad "$p -> $c（经裸 IP）"; fi
  done
  c=$(code "$IP" "/")
  if [ "$c" = "307" ]; then ok "/ -> 307（未登录跳登录）"; else note "/ -> $c（预期 307）"; fi
  if curl -s -m 8 -H "Host: $IP" "http://127.0.0.1/privacy" | grep -q "beian.miit.gov.cn"; then ok "页面里有工信部备案查询链接"; else note "页面里没找到 beian.miit.gov.cn 链接"; fi
fi

sect "5. 备案号位、联系邮箱、AI 标识"
if grep -q "^PROBE_ICP_LICENSE=." "$ENVF" 2>/dev/null; then
  ok "PROBE_ICP_LICENSE 已配置：$(grep "^PROBE_ICP_LICENSE=" "$ENVF" | cut -d= -f2-)"
else
  note "PROBE_ICP_LICENSE 未填（备案号下来后填，页脚立刻出号码与工信部链接）"
fi
if grep -q "^PROBE_POLICE_LICENSE=." "$ENVF" 2>/dev/null; then ok "公安备案号已配置"; else note "PROBE_POLICE_LICENSE 未填（公安备案通过后再填）"; fi
if grep -q "^PROBE_CONTACT_EMAIL=." "$ENVF" 2>/dev/null; then ok "PROBE_CONTACT_EMAIL 已配置"; else note "PROBE_CONTACT_EMAIL 未填（隐私政策里的联系邮箱，审核会看）"; fi

sect "6. 日志留存（网络安全法第 21 条：不少于 6 个月）"
ROT=$(grep -E "^[[:space:]]*rotate " /etc/logrotate.d/nginx 2>/dev/null | awk "{print \$2}")
if [ -n "$ROT" ] && [ "$ROT" -ge 180 ]; then ok "nginx 日志 rotate $ROT 天"; else bad "nginx 日志只留 $(printf "%s" "$ROT")天（要 >=180）"; fi
N=$(ls /var/log/nginx/*.gz 2>/dev/null | wc -l)
[ "$N" -gt 0 ] && ok "已归档压缩日志 $N 个" || note "还没有压缩归档的日志"

sect "7. 备份与定时任务"
for t in probe-backup.timer probe-update.timer probe-heat.timer; do
  if systemctl is-active --quiet "$t"; then ok "$t active"; else note "$t 不是 active"; fi
done

sect "8. HTTPS"
if ss -lntp 2>/dev/null | grep -q ":443 "; then ok "443 在监听"; else note "443 未监听（备案通过后签：scripts/server/issue-cert-dns.sh）"; fi

printf "\n结果：FAIL=%d WARN=%d\n" "$fail" "$warn"
[ "$fail" -eq 0 ] || exit 1