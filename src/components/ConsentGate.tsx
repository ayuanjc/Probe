"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  CONSENT_MIN_READ_MS,
  consentCookiePath,
  consentCookieValue,
} from "@/lib/consent";
import { appPath } from "@/lib/base-path";

/**
 * 用户协议的强制确认层。
 *
 * 三个条件**同时**满足，「同意并继续」才会亮：
 *   1. 停在弹层上满 10 秒（倒计时可见，不是偷偷计时）；
 *   2. 关键条款滚动到底（屏幕装得下时视为已读，否则高屏用户会被卡住）；
 *   3. 由用户主动点击。
 *
 * 为什么不是「点一下就行」：需要证明的从来不是「他点过按钮」，而是「他有时间**看到**
 * 免责与责任限制那几段」。所以顺序上把最要命的四条放在摘要最前面，
 * 折叠的全文交给 /terms —— 弹层里塞一万字的结果是没人读，只是把按钮推得更远。
 *
 * 服务端已经判过 cookie（layout 里读的），这里只处理「没同意」的情况，
 * 因此不会出现「弹层闪一下又消失」。
 */

/** 屏幕装得下全部摘要时，不要求滚动（否则大屏用户永远滚不动）。 */
const SCROLL_SLACK_PX = 24;

const KEY_POINTS: { title: string; body: string }[] = [
  {
    title: "这是检索整理工具，不是事实认定",
    body: "摘要是模型生成的阅读辅助，可能出错。任何数字、结论在引用前都必须点开原文核对；本站不保证内容准确、完整或及时。",
  },
  {
    title: "不能作为专业意见或高风险决策依据",
    body: "不构成医疗、法律、税务、投资、会计、安全或人事意见；不得用于信贷、雇佣、保险、住房等受消费者报告法（如美国 FCRA）约束的用途。",
  },
  {
    title: "责任有上限，而且有排除",
    body: "在法律允许的最大范围内，本站按「现状」提供、不作任何担保，并且不承担间接损失、利润损失与数据损失。累计赔偿责任以你实际支付的费用为限（免费期为 0 元）。",
  },
  {
    title: "禁止的行为会导致立即停用",
    body: "绕过限流或访问控制、批量抓取或压测、转售或二次分发结果、用生成内容侵害他人权利、把本站当对外服务的中间层。",
  },
  {
    title: "争议先协商，再按你的所在地分流",
    body: "中国内地用户：运营者所在地法院。美国用户：JAMS 仲裁并有集体诉讼弃权（可在 30 天内书面退出）。新加坡用户：新加坡法院或 SIAC 仲裁。强制法优先。",
  },
];

/**
 * @param initiallyAccepted 服务端已经判过 cookie 的结果（这里不重复判，避免「闪一下」）。
 * @param version 服务端算出的协议版本号（正文哈希）。客户端不能引 node:crypto，
 *                所以它只能从外面传进来；正确性靠「唯一来源」保证 —— 传进来的就是
 *                用来渲染 /terms 的那一份正文算出来的。
 */
export default function ConsentGate({
  initiallyAccepted,
  version,
}: {
  initiallyAccepted: boolean;
  version: string;
}) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  /** 协议页与隐私页不拦：用户得能先读到全文，再回来确认。 */
  const onLegalPage = pathname === "/terms" || pathname === "/privacy";

  const [accepted, setAccepted] = useState(initiallyAccepted);
  const [atBottom, setAtBottom] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState("");
  const startedAt = useRef<number>(Date.now());
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const open = !accepted && !onLegalPage;

  /**
   * 内容装得下就当作已读。这个判断必须**反复做**，不能只在挂载时做一次：
   * 字体晚到、窗口缩放、移动端地址栏收起都会改变可用高度。一次性的判断一旦判成
   * 「没读到底」，而内容又根本滚不动，用户就会被卡在一个永远点不亮的按钮前面 ——
   * 那不是强制阅读，那是坏掉。
   */
  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (el.scrollHeight - el.clientHeight <= SCROLL_SLACK_PX) setAtBottom(true);
  }, []);

  /** 倒计时只在弹层开着时跑；200ms 一档，秒数看起来是连续的，顺便复查一次可见高度。 */
  useEffect(() => {
    if (!open) return;
    startedAt.current = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - startedAt.current);
      measure();
    }, 200);
    return () => window.clearInterval(timer);
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    measure();
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, measure]);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_SLACK_PX) setAtBottom(true);
  }, []);

  const remainingMs = Math.max(0, CONSENT_MIN_READ_MS - elapsed);
  const remaining = Math.ceil(remainingMs / 1000);
  const ready = atBottom && remainingMs === 0 && !submitting;
  const progress = Math.min(100, Math.round(((CONSENT_MIN_READ_MS - remainingMs) / CONSENT_MIN_READ_MS) * 100));

  const accept = useCallback(async () => {
    if (!ready) return;
    setSubmitting(true);
    setFailed("");
    const at = Date.now();
    const msRead = at - startedAt.current;
    try {
      const res = await fetch(appPath("/api/consent"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version, at, msRead }),
      });
      if (!res.ok) {
        // 版本对不上（409）说明协议刚改过：让服务端渲染一次新的弹层文案。
        if (res.status === 409) {
          setAccepted(false);
          setFailed("协议刚刚更新，页面将重新加载。");
          setSubmitting(false);
          router.refresh();
          return;
        }
        throw new Error("consent failed: " + res.status);
      }
    } catch {
      /**
       * 网络断了也不该把人锁在门外 —— 服务端记录没写成只影响举证，
       * 本地 cookie 仍然能让他继续用。这条路径不写日志，就没有「服务端同意记录」。
       */
      document.cookie = [
        CONSENT_COOKIE + "=" + consentCookieValue(version, at),
        "Path=" + consentCookiePath(),
        "Max-Age=" + CONSENT_MAX_AGE_SECONDS,
        "SameSite=Lax",
      ].join("; ");
    }
    setAccepted(true);
    setSubmitting(false);
    router.refresh();
  }, [ready, router, version]);

  const decline = useCallback(() => {
    window.location.href = appPath("/terms");
  }, []);

  const meta = useMemo(
    () => "版本 " + version + " · 需停留 10 秒",
    [version],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-title"
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/85 px-0 py-0 backdrop-blur-sm sm:items-center sm:px-4 sm:py-6"
    >
      <div className="flex max-h-[92vh] w-full max-w-[720px] flex-col overflow-hidden rounded-none border border-neutral-800 bg-neutral-950 shadow-2xl sm:max-h-[86vh] sm:rounded-lg">
        <header className="shrink-0 border-b border-neutral-800 px-5 pb-4 pt-5">
          <p className="font-mono text-[10px] text-neutral-600">探针 · Probe · {meta}</p>
          <h2 id="consent-title" className="mt-1.5 text-[17px] font-semibold leading-tight text-white">
            使用前请阅读并同意《用户协议》
          </h2>
          <p className="mt-1.5 text-[12px] leading-6 text-neutral-500">
            下列五条是这份协议里最会影响你权利的部分。完整条款（含中国内地、美国、新加坡三地的
            管辖与救济安排）见
            <Link
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="mx-1 text-blue-500 hover:underline"
            >
              用户协议全文
            </Link>
            、
            <Link
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="mx-1 text-blue-500 hover:underline"
            >
              隐私政策
            </Link>
            。
            <span className="mx-1 text-neutral-600">·</span>
            <Link
              href="/terms/en"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:underline"
            >
              English
            </Link>
          </p>
        </header>

        <div
          ref={bodyRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
        >
          <ol className="flex flex-col gap-3.5">
            {KEY_POINTS.map((point, i) => (
              <li key={point.title} className="flex gap-3">
                <span className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums text-neutral-600">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <p className="text-[13px] font-medium leading-6 text-neutral-200">{point.title}</p>
                  <p className="mt-1 text-[12px] leading-6 text-neutral-400">{point.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <p className="mt-5 border-t border-neutral-800 pt-4 text-[11px] leading-6 text-neutral-500">
            点击下方确认后，系统会记录本次确认的时间、协议版本与网络地址的哈希指纹，
            作为你同意本协议的凭据。不同意请直接关闭页面：本站为邀请制测试服务，
            未确认协议将无法继续使用。
          </p>

          {/**
           * 底部那道光：内容被裁掉时告诉人「下面还有」。
           * 用 sticky 而不是 absolute 包一层，是因为任何额外的高度容器都会破坏
           * flex-1 的收缩（试过：面板会被内容撑到超过视口，滚都滚不动）。
           */}
          {!atBottom && (
            <div
              aria-hidden="true"
              className="pointer-events-none sticky bottom-0 -mx-5 -mb-4 h-10 bg-gradient-to-t from-neutral-950 to-transparent"
            />
          )}
        </div>

        <footer className="shrink-0 border-t border-neutral-800 bg-neutral-950 px-5 py-4">
          <div className="mb-3 h-0.5 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full bg-blue-500/70 transition-[width] duration-200 ease-linear"
              style={{ width: progress + "%" }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <button
              type="button"
              onClick={accept}
              disabled={!ready}
              className="rounded-md bg-blue-600 px-4 py-2 text-[12px] font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
            >
              {submitting
                ? "正在记录…"
                : remaining > 0
                  ? "同意并继续（" + remaining + "s）"
                  : atBottom
                    ? "同意并继续"
                    : "请先读到底部"}
            </button>
            <button
              type="button"
              onClick={decline}
              className="rounded-md border border-neutral-800 px-4 py-2 text-[12px] text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
            >
              不同意
            </button>
            <span className="ml-auto font-mono text-[10px] text-neutral-600">
              {remaining > 0 ? "还需阅读 " + remaining + " 秒" : atBottom ? "已读 · 可确认" : "还剩一点没读"}
            </span>
          </div>

          {failed && <p className="mt-2 text-[11px] text-amber-500/80">{failed}</p>}
        </footer>
      </div>
    </div>
  );
}