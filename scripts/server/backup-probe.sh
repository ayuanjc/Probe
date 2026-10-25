#!/usr/bin/env bash
# Probe 每日备份（systemd: probe-backup.timer，每天 03:20 左右）
#
# 为什么要有它：探针的全部账号、会话、审计、同意记录都在两个**单文件**里
# （.data/auth/store.json 与 .data/consent/consent.log）。这两个文件一坏，
# 等于所有人被登出、管理员被重种、备案要的同意留痕一起消失，而它们
# 都不是数据库 —— 没有任何自带副本。手工 cp 靠人记得，靠不住。
#
# 备份什么：
#   .data/auth/store.json      账号 / 会话 / 审计（最关键）
#   .data/probe.db             账号级历史（SQLite，WAL）—— 用 sqlite 的在线备份 API 取一致快照
#   .data/consent/consent.log  协议同意留痕（备案查验项）
#   .cache/feedback.jsonl      用户反馈
#   .cache/hn-history.json     热榜基线（丢了只是首屏慢）
#   probe.env                  运行配置（含 key，备份目录 0700）
#   deployed-sha               出问题时知道备份对应哪个提交
set -uo pipefail

APP=/opt/probe/app
DEST=/root/backups/probe
KEEP=14
STAMP=$(date +%Y%m%d-%H%M%S)

umask 077
mkdir -p "$DEST" || exit 1

WORK=$(mktemp -d) || exit 1
trap 'rm -rf "$WORK"' EXIT

missing=0
copy() { # 源 相对路径
  if [ -f "$1" ]; then
    mkdir -p "$WORK/$(dirname "$2")"
    cp -a "$1" "$WORK/$2" || return 1
  else
    echo "[backup] 缺少 $1（跳过）"
    missing=$((missing + 1))
  fi
}


# SQLite 不能直接 cp：WAL 模式下最新的写入还在 -wal 文件里，只拷 .db 会少掉最近的数据，
# 而拷 .db + -wal + -shm 三件套又可能在别的连接写入时得到互不自洽的一套。
# 用 sqlite3 的 backup API（python3 自带）取一份一致快照，落到工作目录后统一打包。
copy_db() { # 源 相对路径
  local src="$1" rel="$2"
  if [ ! -f "$src" ]; then
    echo "[backup] 缺少 $src（跳过）"
    missing=$((missing + 1))
    return 0
  fi
  mkdir -p "$WORK/$(dirname "$rel")"
  if command -v python3 > /dev/null 2>&1; then
    if python3 - "$src" "$WORK/$rel" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
con = sqlite3.connect("file:" + src + "?mode=ro", uri=True, timeout=10)
out = sqlite3.connect(dst)
try:
    con.backup(out)
finally:
    out.close()
    con.close()
PY
    then
      return 0
    fi
    echo "[backup] 警告：probe.db 快照失败（应用可能正持有锁），改为直接拷贝（可能缺最近几条历史）"
  fi
  cp -a "$src" "$WORK/$rel" || return 1
}

copy "$APP/.data/auth/store.json"        auth/store.json
copy "$APP/.data/consent/consent.log"    consent/consent.log
copy "$APP/.cache/feedback.jsonl"        cache/feedback.jsonl
copy "$APP/.cache/hn-history.json"       cache/hn-history.json
copy "/opt/probe/probe.env"              probe.env
copy "/opt/probe/deployed-sha"           deployed-sha
copy_db "$APP/.data/probe.db"            db/probe.db

# 关键文件必须在：少了 store.json 的备份比没有备份更危险（会让人以为有）。
if [ ! -f "$WORK/auth/store.json" ]; then
  echo "[backup] 致命：store.json 不在 $APP/.data/auth/ —— 中止，不生成空备份"
  exit 1
fi

OUT="$DEST/probe-$STAMP.tar.gz"
if ! tar -czf "$OUT" -C "$WORK" .; then
  echo "[backup] 打包失败"
  rm -f "$OUT"
  exit 1
fi

# 校验 1：压缩包完整（截断的 tar 在解包时才报错，那时已经晚了）
if ! tar -tzf "$OUT" > /dev/null 2>&1; then
  echo "[backup] 压缩包损坏，删除"
  rm -f "$OUT"
  exit 1
fi

# 校验 2：store.json 仍是合法 JSON（备份一个半截写入的文件毫无意义）
if command -v python3 > /dev/null 2>&1; then
  if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$WORK/auth/store.json" 2>/dev/null; then
    echo "[backup] 警告：store.json 不是合法 JSON（应用可能正在写）。本次照留，但请核对应用状态。"
  fi
fi

# 校验 3：历史库能打开且结构完整（截断的 SQLite 只有在查询时才报错）
if [ -f "$WORK/db/probe.db" ] && command -v python3 > /dev/null 2>&1; then
  if ! python3 - "$WORK/db/probe.db" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
try:
    row = con.execute("PRAGMA integrity_check").fetchone()
finally:
    con.close()
sys.exit(0 if row and row[0] == "ok" else 1)
PY
  then
    echo "[backup] 警告：备份里的 probe.db 未通过 integrity_check，请核对应用状态"
  fi
fi

# 只有最近 KEEP 份；按修改时间，不看文件名（时间戳排序在跨年时也会错）
ls -1t "$DEST"/probe-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
done

SIZE=$(stat -c %s "$OUT" 2>/dev/null || echo 0)
echo "$STAMP $SIZE missing=$missing" >> "$DEST/index.txt"
echo "[backup] ok $OUT ($SIZE bytes)"
