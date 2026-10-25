"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  btnDanger,
  btnNeutral,
  btnPrimary,
  deviceLabel,
  emptyClass,
  since,
  time,
  type Notice,
  type PublicSession,
} from "./shared";

/**
 * 某个用户的登录设备抽屉（管理员视角）。
 *
 * 这里只显示 ipHash 前 8 位 —— 库里存的就是不可逆指纹，
 * 「是不是同一台机器」能看出来，具体地址看不出来，也不需要看出来。
 */
export default function SessionsDrawer({
  userId,
  username,
  selfId,
  onClose,
  onSay,
}: {
  userId: string;
  username: string;
  selfId: string;
  onClose: () => void;
  onSay: (notice: Notice) => void;
}) {
  const [sessions, setSessions] = useState<PublicSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api<{ sessions: PublicSession[] }>(
      "/api/admin/sessions?userId=" + encodeURIComponent(userId),
    );
    if (r.ok && r.data) setSessions(r.data.sessions);
    else onSay({ kind: "err", text: r.message });
    setLoading(false);
  }, [userId, onSay]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const revokeOne = async (s: PublicSession) => {
    if (!window.confirm(`撤销这台设备的登录？它需要重新输入密码。\n${deviceLabel(s.userAgent)} · ${since(s.lastSeenAt)}`)) {
      return;
    }
    setBusy(s.id);
    const r = await api(
      "/api/admin/sessions?userId=" +
        encodeURIComponent(userId) +
        "&id=" +
        encodeURIComponent(s.id),
      { method: "DELETE" },
    );
    setBusy("");
    if (!r.ok) {
      onSay({ kind: "err", text: r.message });
      return;
    }
    onSay({ kind: "ok", text: "已撤销这台设备" });
    await load();
  };

  const revokeAll = async () => {
    if (!window.confirm(`让 ${username} 的全部设备重新登录？`)) return;
    setBusy("all");
    const r = await api<{ revoked: number }>(
      "/api/admin/sessions?userId=" + encodeURIComponent(userId) + "&all=1",
      { method: "DELETE" },
    );
    setBusy("");
    if (!r.ok) {
      onSay({ kind: "err", text: r.message });
      return;
    }
    onSay({ kind: "ok", text: `已撤销 ${r.data?.revoked ?? 0} 枚会话` });
    await load();
  };

  const liveCount = sessions.filter((s) => s.live).length;
  const isSelf = userId === selfId;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col border-l border-neutral-800 bg-[#0b0b0b] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <div>
            <h2 className="font-mono text-[12px] text-neutral-200">登录设备 · {username}</h2>
            <p className="mt-0.5 font-mono text-[10px] text-neutral-600">
              {loading ? "读取中…" : `${liveCount} 台在线 / 共 ${sessions.length} 条记录`}
            </p>
          </div>
          <button type="button" className={btnNeutral} onClick={onClose}>
            关闭
          </button>
        </header>

        {isSelf && (
          <p className="mx-4 mt-3 rounded border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-300">
            这是你自己的账号。撤销哪一台，哪一台就要立刻重新登录 —— 包括你正在用的这一台。
          </p>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {sessions.length === 0 && !loading && (
            <p className={emptyClass}>没有会话记录。这个用户还没登录过，或者全被清掉了。</p>
          )}
          <ul className="flex flex-col gap-2">
            {sessions.map((s) => (
              <li
                key={s.id}
                className={
                  "rounded border p-3 " +
                  (s.live ? "border-neutral-800 bg-[#0f0f0f]" : "border-neutral-900 bg-black/40 opacity-60")
                }
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[12px] text-neutral-200">{deviceLabel(s.userAgent)}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-neutral-600">
                      IP 指纹 {s.ipHash.slice(0, 8)} · 最后活跃 {since(s.lastSeenAt)}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] text-neutral-700">
                      登录于 {time(s.createdAt)} · 到期 {time(s.expiresAt)}
                    </p>
                  </div>
                  <span
                    className={
                      "shrink-0 font-mono text-[10px] " + (s.live ? "text-emerald-500" : "text-neutral-600")
                    }
                  >
                    {s.live ? "在线" : "已失效"}
                  </span>
                </div>
                {s.userAgent && (
                  <p className="mt-1 truncate font-mono text-[10px] text-neutral-700" title={s.userAgent}>
                    {s.userAgent}
                  </p>
                )}
                {s.live && (
                  <div className="mt-2">
                    <button
                      type="button"
                      className={btnDanger}
                      disabled={busy === s.id}
                      onClick={() => void revokeOne(s)}
                    >
                      {busy === s.id ? "撤销中…" : "撤销这台"}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>

        <footer className="flex items-center gap-2 border-t border-neutral-800 px-4 py-3">
          <button
            type="button"
            className={btnPrimary}
            disabled={busy === "all" || liveCount === 0}
            onClick={() => void revokeAll()}
          >
            {busy === "all" ? "处理中…" : "全部踢下线"}
          </button>
          <span className="font-mono text-[10px] text-neutral-600">会话是服务端记录，撤销即刻生效</span>
        </footer>
      </div>
    </div>
  );
}
