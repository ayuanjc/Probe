"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, MessageSquare, X } from "lucide-react";
import { appPath } from "@/lib/base-path";

const MAX_MESSAGE = 2000;
const MAX_CONTACT = 120;

/**
 * 页脚的反馈入口：一个小按钮 + 一个浮层。
 *
 * 三个决定：
 * - 不做「五星好评」那类结构化打分：能写的只有一段话，反馈里最有价值的是上下文，
 *   而上下文（查询词、页面）本来就是自动带上的，不需要用户填表。
 * - 浮层走 portal + fixed：页脚在结果页里可能被 grid 的定位与 overflow 影响，
 *   挂在 body 上最稳（术语气泡与 DIY 面板踩过同一个坑）。
 * - 提交后不留输入内容：写进磁盘的只有那一条，页面上说「已收到 <id>」，
 *   别让用户以为还在草稿箱里。
 */
export default function FeedbackButton({ query }: { query?: string }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState("");
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => areaRef.current?.focus(), 40);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const submit = async () => {
    const text = message.trim();
    if (text.length < 2) {
      setState("error");
      setNote("写两句再发吧（至少 2 个字）。");
      return;
    }
    setState("sending");
    setNote("");
    try {
      const res = await fetch(appPath("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          contact: contact.trim(),
          query: query ?? "",
          page: typeof location === "undefined" ? "" : location.pathname + location.search,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: true; id: string }
        | { ok: false; message?: string }
        | null;
      if (!res.ok || !data || data.ok !== true) {
        setState("error");
        setNote(
          data && "message" in data && data.message
            ? data.message
            : "没发出去（HTTP " + res.status + "）。稍后再试一次。",
        );
        return;
      }
      setState("ok");
      setReceipt(data.id);
      setMessage("");
      setContact("");
    } catch {
      setState("error");
      setNote("网络断了，这条没发出去。");
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          setState("idle");
          setNote("");
          setOpen(true);
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 px-2.5 py-1.5 text-[11px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
        aria-haspopup="dialog"
        data-feedback-trigger
      >
        <MessageSquare aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />
        反馈
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 p-4 sm:items-center"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="反馈"
              data-feedback-dialog
              className="rise w-full max-w-[520px] rounded-md border border-neutral-800 bg-[#111] p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-medium text-white">反馈</h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                    直接写给作者：哪里看不懂、哪个数字你不同意、缺什么面板，都行。
                    {query ? " 会带上当前查询词「" + query + "」，方便复现。" : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={close}
                  aria-label="关闭反馈"
                  className="-mr-1 -mt-1 rounded p-1 text-neutral-600 transition-colors hover:text-white"
                >
                  <X aria-hidden className="h-4 w-4" strokeWidth={1.5} />
                </button>
              </div>

              {state === "ok" ? (
                <div className="mt-4 rounded-md border border-neutral-800 bg-[#0f0f0f] p-4">
                  <p className="flex items-center gap-2 text-[13px] text-white">
                    <Check aria-hidden className="h-4 w-4 text-blue-500" strokeWidth={1.5} />
                    已收到，谢谢。
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-neutral-600">编号 {receipt}</p>
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setState("idle")}
                      className="rounded-md border border-neutral-800 px-2.5 py-1.5 text-[11px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
                    >
                      再写一条
                    </button>
                    <button
                      type="button"
                      onClick={close}
                      className="text-[11px] text-neutral-500 transition-colors hover:text-white"
                    >
                      关闭
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <label className="mt-4 block">
                    <span className="sr-only">反馈内容</span>
                    <textarea
                      ref={areaRef}
                      value={message}
                      onChange={(event) => setMessage(event.target.value.slice(0, MAX_MESSAGE))}
                      rows={5}
                      placeholder="比如：置信度里的「一手性」我没看懂它和转载的关系。"
                      data-feedback-message
                      className="min-h-[120px] w-full resize-y rounded-md border border-neutral-800 bg-[#0f0f0f] px-3 py-2 text-[13px] leading-relaxed text-white outline-none placeholder:text-neutral-600 focus:border-neutral-600"
                    />
                  </label>
                  <div className="mt-1 flex justify-end font-mono text-[10px] tabular-nums text-neutral-700">
                    {message.length}/{MAX_MESSAGE}
                  </div>

                  <label className="mt-2 block">
                    <span className="sr-only">联系方式（可选）</span>
                    <input
                      value={contact}
                      onChange={(event) => setContact(event.target.value.slice(0, MAX_CONTACT))}
                      placeholder="联系方式（可选，邮箱或 GitHub 用户名）"
                      className="w-full rounded-md border border-neutral-800 bg-[#0f0f0f] px-3 py-2 text-[12px] text-white outline-none placeholder:text-neutral-600 focus:border-neutral-600"
                    />
                  </label>

                  {state === "error" && note && (
                    <p role="alert" className="mt-3 rounded-md border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-400">
                      {note}
                    </p>
                  )}

                  <div className="mt-4 flex items-center justify-between gap-3">
                    <p className="font-mono text-[10px] text-neutral-700">
                      存在服务器本机文件里，不上报第三方。
                    </p>
                    <div className="flex shrink-0 items-center gap-3">
                      <button
                        type="button"
                        onClick={close}
                        className="text-[11px] text-neutral-500 transition-colors hover:text-white"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={submit}
                        disabled={state === "sending"}
                        className="rounded-md bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:bg-neutral-800 disabled:text-neutral-600"
                        data-feedback-send
                      >
                        {state === "sending" ? "发送中…" : "发送"}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}