#!/usr/bin/env bash
# 备案通过后：恢复站点（域名白名单 + 裸 IP/陌生 Host 444）。
# 用法：bash /opt/probe/bin/beian-reopen.sh --yes
# 注意：先填 PROBE_ICP_LICENSE 再开站，否则页脚没有备案号。
set -euo pipefail
export PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

EN=/etc/nginx/sites-enabled
AV=/etc/nginx/sites-available
ENVF=/opt/probe/probe.env
STAMP=$(date +%Y%m%d-%H%M%S)
SNAP=/root/nginx-snap-$STAMP

[ "${1:-}" = "--yes" ] || { echo "这会打开站点。确认请加 --yes"; exit 2; }

echo "== 1. 备案号检查"
if grep -q "^PROBE_ICP_LICENSE=." "$ENVF" 2>/dev/null; then
  echo "  已配置：$(grep "^PROBE_ICP_LICENSE=" "$ENVF" | cut -d= -f2-)"
else
  echo "  [WARN] PROBE_ICP_LICENSE 还没填 —— 页脚不会出现备案号"
  echo "     echo 'PROBE_ICP_LICENSE=粤ICP备XXXXXXXX号-1' >> $ENVF && systemctl restart probe-web"
fi

echo "== 2. 备份当前状态到 $SNAP"
mkdir -p "$SNAP"; cp -a "$EN"/. "$SNAP"/
restore() { rm -f "$EN"/*; cp -a "$SNAP"/. "$EN"/; systemctl reload nginx || true; echo "已回滚"; }
trap "echo 失败，回滚; restore; exit 1" ERR

echo "== 3. 启用 probe-root，撤掉 probe-block / probe-closed / probe-temp-open"
rm -f "$EN"/probe-block "$EN"/probe-closed "$EN"/probe-temp-open
ln -sfn "$AV/probe-root" "$EN/probe-root"
ls -l "$EN"
nginx -t && systemctl reload nginx && sleep 1

echo "== 4. 自检"
c=$(curl -s -o /dev/null -m 8 -w "%{http_code}" -H "Host: ayuanjc.online" http://127.0.0.1/login)
printf "  domain /login -> %s（期望 200）\n" "$c"
[ "$c" = "200" ] || { echo "  域名通道不通，检查 probe-root"; exit 1; }
c=$(curl -s -o /dev/null -m 8 -w "%{http_code}" http://127.0.0.1/ || true)
printf "  bare-ip       -> %s（期望 444/000）\n" "$c"
case "$c" in 000|444) ;; *) echo "  裸 IP 还能打开：把 probe-block（带 default_server）也启用";; esac
if curl -s -m 8 -H "Host: ayuanjc.online" http://127.0.0.1/privacy | grep -q "beian.miit.gov.cn"; then
  echo "  页脚备案号链接：在"
else
  echo "  [WARN] 页脚没有备案号链接（PROBE_ICP_LICENSE 没配或没重启）"
fi
trap - ERR

echo
echo "下一步："
echo "  1) DNSPod 确认 A 记录已恢复（审核期停用过的话）"
echo "  2) 30 日内公安联网备案：https://beian.mps.gov.cn/"
echo "  3) 签 HTTPS：bash /opt/probe/bin/issue-cert-dns.sh"