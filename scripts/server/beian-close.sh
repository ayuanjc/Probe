#!/usr/bin/env bash
# 备案审核期：把 80 端口上的一切关掉（域名、裸 IP、陌生 Host 一律 444）。
# 用法：bash /opt/probe/bin/beian-close.sh --yes
# 幂等；先 nginx -t 再 reload；任何一步失败自动回滚到切换前；最后自检。
set -euo pipefail
export PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

EN=/etc/nginx/sites-enabled
AV=/etc/nginx/sites-available
STAMP=$(date +%Y%m%d-%H%M%S)
SNAP=/root/nginx-snap-$STAMP

[ "${1:-}" = "--yes" ] || { echo "这会关掉站点（域名与裸 IP 都进不来）。确认请加 --yes"; exit 2; }

echo "== 1. 备份当前 sites-enabled 到 $SNAP"
mkdir -p "$SNAP"
cp -a "$EN"/. "$SNAP"/

restore() { rm -f "$EN"/*; cp -a "$SNAP"/. "$EN"/; systemctl reload nginx || true; echo "已回滚到切换前"; }
trap "echo 失败，回滚; restore; exit 1" ERR

echo "== 2. 只留 probe-block（default_server 444）"
rm -f "$EN"/probe-temp-open "$EN"/probe-temp-ip "$EN"/probe-root "$EN"/probe-block "$EN"/probe-closed
ln -sfn "$AV/probe-block" "$EN/probe-block"
ls -l "$EN"

echo "== 3. 语法检查"
nginx -t

echo "== 4. reload"
systemctl reload nginx
sleep 1

echo "== 5. 自检（期望 000 或 444）"
check() { # check <host|->
  local h="$1" c
  if [ "$h" = "-" ]; then c=$(curl -s -o /dev/null -m 6 -w "%{http_code}" http://127.0.0.1/ || true)
  else c=$(curl -s -o /dev/null -m 6 -w "%{http_code}" -H "Host: $h" http://127.0.0.1/ || true); fi
  printf "  %-24s -> %s\n" "$h" "$c"
  case "$c" in 000|444) return 0;; *) echo "  意外：$h 仍返回 $c"; return 1;; esac
}
check "-"
check 106.52.116.164
check ayuanjc.online
check www.ayuanjc.online
check not-my-domain.example
trap - ERR

echo
echo "审核期形态已生效：应用还在 127.0.0.1:3215 跑，只是外面进不来。"
echo "要看页面：curl -H 'Host: ayuanjc.online' http://127.0.0.1:3215/login"
echo "备案通过后：bash /opt/probe/bin/beian-reopen.sh --yes"
echo "回滚：rm -f $EN/* && cp -a $SNAP/. $EN/ && systemctl reload nginx"