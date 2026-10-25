#!/usr/bin/env bash
# 用 DNS-01 给 ayuanjc.online 签证书（备案期唯一可行的方式）
#
# 为什么不能 HTTP-01：备案未通过期间，域名在腾讯云侧被阻断 —— 任何公网 HTTP 请求
# 都被 302 到 dnspod.qcloud.com/static/webblock.html。Let's Encrypt 的校验机也从
# 公网来，一样被拦，它永远读不到 nginx 下的 /.well-known/acme-challenge/。
# DNS-01 走 DNS TXT 记录，绕开 HTTP 阻断，也不需要站点对外开放。
#
# 前提：/opt/probe/dns.env 里放 DNSPod 的 API 凭据（格式 "ID,Token"，
# 在 https://console.dnspod.cn/account/token 创建，权限勾「域名相关」即可）：
#
#   DNSPOD_TOKEN="123456,abcdef0123456789abcdef0123456789"
#   CERT_EMAIL="you@example.com"
#
# 然后：chmod 600 /opt/probe/dns.env && /opt/probe/bin/issue-cert-dns.sh
# 只想看生成的 hook 对不对：HOOKS_ONLY=1 /opt/probe/bin/issue-cert-dns.sh
#
# 续期：certbot.timer 已在跑。manual 模式的续期同样要这套 hook，所以本脚本会把
# hook 写进 /etc/letsencrypt/renewal-hooks/，续期时自动使用 —— 之后不需要人管。
set -euo pipefail

DOMAIN="ayuanjc.online"
ALT_DOMAIN="www.ayuanjc.online"
ENV_FILE=/opt/probe/dns.env
HOOK_DIR=/etc/letsencrypt/renewal-hooks
RECORD_FILE=/tmp/acme-dnspod.record

if [ -z "${HOOKS_ONLY:-}" ]; then
  [ -f "$ENV_FILE" ] || { echo "缺少 $ENV_FILE（DNSPOD_TOKEN / CERT_EMAIL）"; exit 1; }
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  : "${DNSPOD_TOKEN:?dns.env 里没有 DNSPOD_TOKEN}"
  : "${CERT_EMAIL:?dns.env 里没有 CERT_EMAIL}"
else
  echo "HOOKS_ONLY：只生成 hook，不签发"
fi

command -v dig > /dev/null || echo "警告：没有 dig，TXT 生效的轮询会被跳过（apt install dnsutils）"

mkdir -p "$HOOK_DIR/pre" "$HOOK_DIR/post"
umask 077

# hook 的前半段（两个 hook 共用）。DNSPod 的鉴权是「URL 编码表单 +
# login_token=ID,Token」，不是 Bearer —— 别照别家服务商的例子改。
write_head() {
  cat <<'HEAD'
#!/usr/bin/env bash
# certbot 的 DNS-01 hook（由 issue-cert-dns.sh 生成，别手改）
set -euo pipefail
. /opt/probe/dns.env
RECORD_FILE=/tmp/acme-dnspod.record

# DNSPod 的所有调用都是这一个形状
dp() {
  local path=$1; shift
  curl -fsS -m 20 -X POST "https://dnsapi.cn/$path" --data-urlencode "login_token=$DNSPOD_TOKEN" --data-urlencode "format=json" --data-urlencode "lang=zh" "$@"
}

# 从响应的 status.code 取结果码（1 = 成功）
dp_code() {
  python3 -c 'import sys,json;print(json.load(sys.stdin)["status"]["code"])'
}
HEAD
}

# --- auth hook：建 TXT 记录，等它在权威 NS 上生效 ---
{
  write_head
  cat <<'BODY'

domain="$CERTBOT_DOMAIN"
# 主域用 _acme-challenge；www 这类要给「相对主域」的完整名字
case "$domain" in
  "ayuanjc.online") sub="_acme-challenge" ;;
  *) sub="_acme-challenge.${domain%.ayuanjc.online}" ;;
esac

resp=$(dp "Record.Create" --data-urlencode "domain=ayuanjc.online" --data-urlencode "sub_domain=$sub" --data-urlencode "record_type=TXT" --data-urlencode "record_line=默认" --data-urlencode "value=$CERTBOT_VALIDATION" --data-urlencode "ttl=600")

code=$(printf '%s' "$resp" | dp_code || echo "?")
if [ "$code" != "1" ]; then
  # 常见原因：API token 权限不够、域名不在这个账号下、TXT 记录数超限
  echo "DNSPod 建记录失败（status.code=$code）：$resp" >&2
  exit 1
fi

rid=$(printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin)["record"]["id"])')
echo "$sub $rid" >> "$RECORD_FILE"
echo "已建 TXT：$sub.ayuanjc.online（record_id=$rid）"

# 生效要时间（DNSPod 通常 10–60 秒）。问权威 NS，别问本地缓存。
if command -v dig > /dev/null; then
  for i in $(seq 1 40); do
    got=$(dig +short TXT "$sub.ayuanjc.online" @equuleus.dnspod.net 2>/dev/null | tr -d '"' | tr -d ' ')
    if [ "$got" = "$CERTBOT_VALIDATION" ]; then
      echo "TXT 已生效（$((i * 5)) 秒）"
      exit 0
    fi
    sleep 5
  done
  echo "200 秒内没读到 TXT，仍交给 Let's Encrypt 去试" >&2
fi
BODY
} > "$HOOK_DIR/pre/dnspod-auth.sh"

# --- cleanup hook：删掉建过的记录（失败也不拦，否则证书卡在 pending 校验） ---
{
  write_head
  cat <<'BODY'

[ -f "$RECORD_FILE" ] || exit 0
while read -r sub rid; do
  [ -n "$rid" ] || continue
  dp "Record.Remove" --data-urlencode "domain=ayuanjc.online" --data-urlencode "record_id=$rid" > /dev/null || true
done < "$RECORD_FILE"
rm -f "$RECORD_FILE"
BODY
} > "$HOOK_DIR/post/dnspod-cleanup.sh"

chmod 700 "$HOOK_DIR/pre/dnspod-auth.sh" "$HOOK_DIR/post/dnspod-cleanup.sh"
echo "hook 已写入 $HOOK_DIR/{pre,post}/"

if [ -n "${HOOKS_ONLY:-}" ]; then
  echo "--- pre："; cat "$HOOK_DIR/pre/dnspod-auth.sh"
  exit 0
fi

certbot certonly --manual --preferred-challenges dns --manual-auth-hook "$HOOK_DIR/pre/dnspod-auth.sh" --manual-cleanup-hook "$HOOK_DIR/post/dnspod-cleanup.sh" --non-interactive --agree-tos -m "$CERT_EMAIL" --cert-name "$DOMAIN" -d "$DOMAIN" -d "$ALT_DOMAIN"

echo
echo "证书就位：/etc/letsencrypt/live/$DOMAIN/{fullchain,privkey}.pem"
echo "下一步：cp scripts/server/nginx-probe-tls.conf /etc/nginx/sites-available/probe-root（见 docs/OPS.md）"
