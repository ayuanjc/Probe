"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { appPath } from "@/lib/base-path";
import { api, btnDanger, btnNeutral, deviceLabel, ipFingerprint, since, time, type PublicSession } from "./admin/shared";

/**
 * 自己的登录设备（/account 页）。
 *
 * 与后台那个抽屉的区别：这里 userId 只有一种可能 —— 自己。没有 ?userId= 可传，
 * 也就没有"越权踢别人"这种失败模式；撤销当前这一台等同退出登录。
 */
export default function AccountSessions() {
  const router = useRouter();
  const [sessions, setSessions] = useState<PublicSession[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const say = (kind: "ok" | "err", text: string) => setMessage({ kind, text });

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api<{ sessions: PublicSession[]; currentSessionId: string | null }>("/api/auth/sessions");
    if (r.ok && r.data) {
      setSessions(r.data.sessions);
      setCurrentId(r.data.currentSessionId);
    } else {
      say("err", r.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (s: PublicSession) => {
    const isCurrent = s.id === currentId;
    if (
      !window.confirm(
        isCurrent
          ? "这是你当前使用的设备。撤销会立刻退出登录，确定？"
          : "撤销这台设备的登录？它需要重新输入密码。",
      )
    ) {
      return;
    }
    setBusy(s.id);
    const r = await api<{ signedOut?: boolean }>("/api/auth/sessions?id=" + encodeURIComponent(s.id), {
      method: "DELETE",
    });
    setBusy("");
    if (!r.ok) {
      say("err", r.message);
      return;
    }
    if (r.data?.signedOut) {
      router.replace(appPath("/login"));
      return;
    }
    say("ok", "已撤销");
    await load();
  };

  const revokeOthers = async () => {
    if (!window.confirm("让除当前设备以外的全部设备重新登录？")) return;
    setBusy("others");
    const r = await api<{ revoked: number }>("/api/auth/sessions?others=1", { method: "DELETE" });
    setBusy("");
    if (!r.ok) {
      say("err", r.message);
      return;
    }
    say("ok", `已撤销 ${r.data?.revoked ?? 0} 台设备`);
    await load();
  };

  const others = sessions.filter((s) => s.live && s.id !== currentId).length;

  return (
    <div className="flex flex-col gap-3">
      {message && (
        <p
          className={
            "rounded border px-3 py-2 text-[12px] " +
            (message.kind === "ok"
              ? "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-400"
              : "border-red-500/30 bg-red-500/[0.06] text-red-400")
          }
        >
          {message.text}
        </p>
      )}

      {loading && <p className="font-mono text-[11px] text-neutral-600">读取中…</p>}

      {!loading && sessions.length === 0 && (
        <p className="font-mono text-[11px] text-neutral-600">没有会话记录。</p>
      )}

      <ul className="flex flex-col gap-2">
        {sessions.map((s) => {
          const isCurrent = s.id === currentId;
          return (
            <li
              key={s.id}
              className={
                "rounded border p-3 " +
                (s.live
                  ? isCurrent
                    ? "border-blue-500/40 bg-blue-500/[0.04]"
                    : "border-neutral-800 bg-[#0f0f0f]"
                  : "border-neutral-900 bg-black/40 opacity-60")
              }
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[12px] text-neutral-200">
                    {deviceLabel(s.userAgent)}
                    {isCurrent && <span className="ml-1.5 text-[10px] text-blue-400">当前设备</span>}
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] text-neutral-600">
                    IP 指纹 {ipFingerprint(s.ipHash)} · 最后活跃 {since(s.lastSeenAt)}
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] text-neutral-700">
                    登录于 {time(s.createdAt)} · 到期 {time(s.expiresAt)}
                  </p>
                </div>
                {s.live && (
                  <button
                    type="button"
                    className={isCurrent ? btnNeutral : btnDanger}
                    disabled={busy === s.id}
                    onClick={() => void revoke(s)}
                  >
                    {busy === s.id ? "撤销中…" : isCurrent ? "退出登录" : "撤销"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {others > 0 && (
        <button type="button" className={btnDanger} disabled={busy === "others"} onClick={() => void revokeOthers()}>
          {busy === "others" ? "处理中…" : `退出其它 ${others} 台设备`}
        </button>
      )}

      <p className="font-mono text-[10px] text-neutral-700">
        会话只以哈希形式保存在服务器上，这里只显示 IP 的不可逆指纹。
      </p>
    </div>
  );
}
