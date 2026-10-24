"use client";

import { useCallback, useEffect, useState } from "react";
import { appPath } from "@/lib/base-path";

/**
 * 右下角那一小块身份条：谁登录着、退出、进后台。
 *
 * 三种不显示的情况，都是刻意的：
 * - 鉴权关着（PROBE_AUTH_MODE=off）：测试结束后退回开放状态，别留一个假登录；
 * - 还没问到结果（首帧）：宁可晚半秒出现，也不要先闪一次"未登录"；
 * - 登录页自己：那里已经是登录框，再挂一条"未登录"纯属噪音。
 */

type Me = {
  ok: boolean;
  auth: boolean;
  mode: "on" | "off";
  user: { username: string; role: "admin" | "member"; mustChangePassword: boolean } | null;
};

export default function SessionBar() {
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(appPath("/api/auth/me"), { cache: "no-store" });
      if (!res.ok) return;
      setMe((await res.json()) as Me);
    } catch {
      // 网络抖动就保持现状：这条信息条不该在断网时变成错误提示。
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const logout = async () => {
    setBusy(true);
    try {
      await fetch(appPath("/api/auth/logout"), { method: "POST" });
    } catch {
      // 就算请求失败也把本地状态当已退出：cookie 由服务端决定，刷新一次自然对齐。
    }
    setBusy(false);
    window.location.href = appPath("/login");
  };

  if (!me || !me.auth || !me.user) return null;

  return (
    <div className="fixed bottom-3 right-3 z-40 print:hidden">
      {open ? (
        <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-[#0a0a0a]/95 px-2.5 py-1.5 shadow-lg backdrop-blur">
          <span className="font-mono text-[11px] text-neutral-400">
            {me.user.username}
            {me.user.role === "admin" && <span className="ml-1 text-blue-400">·admin</span>}
          </span>
          {me.user.role === "admin" && (
            <a
              href={appPath("/admin")}
              className="rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
            >
              后台
            </a>
          )}
          <a
            href={appPath("/account")}
            className="rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
          >
            改密
          </a>
          <button
            type="button"
            onClick={() => void logout()}
            disabled={busy}
            className="rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400 transition-colors hover:border-red-500/40 hover:text-red-400 disabled:opacity-40"
          >
            {busy ? "…" : "退出"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="收起"
            className="px-1 font-mono text-[10px] text-neutral-600 transition-colors hover:text-white"
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-full border border-neutral-800 bg-[#0a0a0a]/90 px-2.5 py-1 font-mono text-[10px] text-neutral-500 shadow-lg backdrop-blur transition-colors hover:border-neutral-600 hover:text-white"
        >
          <span
            className={
              "inline-block h-1.5 w-1.5 rounded-full " +
              (me.user.mustChangePassword ? "bg-amber-400" : "bg-emerald-500")
            }
          />
          {me.user.username}
        </button>
      )}
    </div>
  );
}
