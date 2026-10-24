"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appPath } from "@/lib/base-path";

/**
 * 服务器上的自动更新拉一次新代码、重新构建、重启进程之后，
 * 还开着页面的浏览器仍在跑旧 bundle。这里每分钟问一次构建号，
 * 变了才弹一条 —— 不自动刷新：用户可能正读到摘要一半。
 */
const POLL_MS = 60_000;
/** 重建那段窗口里进程会短暂不可用：失败后别等满一分钟，10 秒后再问一次。 */
const RETRY_MS = 10_000;

type Payload = { buildId: string; startedAt: string };

export default function UpdateBanner() {
  const [fresh, setFresh] = useState<Payload | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const mine = useRef<string | null>(null);
  const retry = useRef<number | null>(null);

  /** 返回 false 表示这次没问到有效构建号（进程正在重启 / 网络抖动）。 */
  const check = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(appPath("/api/version"), { cache: "no-store" });
      if (!res.ok) return false;
      const data = (await res.json()) as Payload;
      if (!data?.buildId || data.buildId === "unknown") return false;
      if (mine.current === null) {
        mine.current = data.buildId;
        return true;
      }
      if (data.buildId !== mine.current) setFresh(data);
      return true;
    } catch {
      // 一次网络抖动不该让提示误报，也不该影响检索：稍后重问。
      return false;
    }
  }, []);

  const schedule = useCallback(() => {
    if (retry.current !== null) return;
    retry.current = window.setTimeout(async () => {
      retry.current = null;
      if (!(await check())) schedule();
    }, RETRY_MS);
  }, [check]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive || document.visibilityState !== "visible") return;
      if (!(await check())) schedule();
    };
    void tick();
    const timer = window.setInterval(tick, POLL_MS);
    // 手机把标签页挂到后台会暂停定时器：切回来先查一次再等下一分钟。
    document.addEventListener("visibilitychange", tick);
    return () => {
      alive = false;
      window.clearInterval(timer);
      if (retry.current !== null) window.clearTimeout(retry.current);
      retry.current = null;
      document.removeEventListener("visibilitychange", tick);
    };
  }, [check, schedule]);

  if (!fresh || dismissed) return null;

  return (
    <div
      role="status"
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[70] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-md border border-neutral-700 bg-[#111] p-3"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-white">线上已经换了新版本</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">
            这一页是几分钟前的构建。刷新就换成新的；正在读的内容会丢，先不刷新也没问题。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="min-h-9 rounded-md bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500"
          >
            刷新
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="min-h-9 rounded-md px-2 py-1.5 text-[11px] text-neutral-500 transition-colors hover:text-white"
          >
            稍后
          </button>
        </div>
      </div>
    </div>
  );
}