"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appPath } from "@/lib/base-path";
import { readHistory } from "@/lib/history";
import { time, type Notice } from "./admin/shared";

/**
 * 我的历史（/account 页）。
 *
 * 三条设计口径：
 *   1. **服务器没开历史就整块不渲染** —— 不是渲染一个空列表。空列表会被读成
 *      「我上个月问的东西被你们删了」，而真相是这件功能没开。
 *   2. **每条都能单独删，清空要打两个字** —— 历史是私人轨迹，
 *      一个误触的按钮不该把它抹掉。
 *   3. **列表只显示索引**：提问原文、时间、三态计数、读了哪些站。
 *      正文从来不在这里，因为它从来不落库。
 */

type HistoryCounts = { claims: number; supported: number; contradicted: number; unknown: number };
type HistoryRow = {
  id: string;
  query: string;
  at: number;
  region: string;
  intentKind: string | null;
  counts: HistoryCounts;
  degraded: string[];
  sources: number;
  hosts: string[];
};

type ListResponse = { ok: boolean; enabled?: boolean; items?: HistoryRow[]; next?: number | null; total?: number; message?: string };

const REGION_TEXT: Record<string, string> = { cn: "境内", intl: "境外" };

function countsText(c: HistoryCounts): string {
  const judged = c.supported + c.contradicted + c.unknown;
  if (judged === 0) {
    // 断言抽出来了却一条都没判：如实说「未核验」，绝不写「0 条支持」——
    // 那会被读成「全是假的」。
    return c.claims > 0 ? `${c.claims} 条断言 · 未核验` : "无断言";
  }
  return `${c.claims} 条断言 · 支持 ${c.supported} / 矛盾 ${c.contradicted} / 未核验 ${c.unknown}`;
}

export default function AccountHistory() {
  const [items, setItems] = useState<HistoryRow[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  /** 关键词过滤：只在服务端查（列表可能只有最近 20 条，前端过滤会漏）。 */
  const [needle, setNeedle] = useState("");
  const [query, setQuery] = useState("");

  const say = (kind: Notice["kind"], text: string) => setNotice({ kind, text });

  const load = useCallback(
    async (opts: { append?: boolean; before?: number | null; q?: string } = {}) => {
      setLoading(true);
      const params = new URLSearchParams({ limit: "20" });
      if (opts.before) params.set("before", String(opts.before));
      const q = (opts.q ?? "").trim();
      if (q.length >= 2) params.set("q", q);
      try {
        const res = await fetch(appPath("/api/history") + "?" + params.toString(), { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as ListResponse | null;
        if (!data) {
          say("err", "服务器返回的不是 JSON，稍后重试。");
          setLoading(false);
          return;
        }
        if (data.enabled === false) {
          // 功能没开：整块隐藏（见文件头第 1 条）。
          setEnabled(false);
          setLoading(false);
          return;
        }
        if (!res.ok || !data.ok) {
          say("err", data.message ?? "读取历史失败。");
          setLoading(false);
          return;
        }
        setEnabled(true);
        const rows = data.items ?? [];
        setItems((prev) => (opts.append ? prev.concat(rows) : rows));
        setNext(data.next ?? null);
        setTotal(typeof data.total === "number" ? data.total : null);
      } catch {
        say("err", "网络异常，请检查连接后重试。");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (row: HistoryRow) => {
    if (!window.confirm("删掉这条记录？删了恢复不了。")) return;
    setBusy(row.id);
    try {
      const res = await fetch(appPath("/api/history") + "?id=" + encodeURIComponent(row.id), { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!res.ok || !data?.ok) {
        say("err", data?.message ?? "删除失败。");
        return;
      }
      setItems((prev) => prev.filter((r) => r.id !== row.id));
      setTotal((t) => (t === null ? t : Math.max(0, t - 1)));
      say("ok", "已删除");
    } catch {
      say("err", "网络异常，请检查连接后重试。");
    } finally {
      setBusy("");
    }
  };

  const clearAll = async () => {
    // 要打字确认：这一个按钮会抹掉整本历史。
    const typed = window.prompt("清空全部历史。这一步恢复不了 —— 输入 DELETE 确认：");
    if (typed !== "DELETE") return;
    setBusy("all");
    try {
      const res = await fetch(appPath("/api/history"), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; removed?: number; message?: string } | null;
      if (!res.ok || !data?.ok) {
        say("err", data?.message ?? "清空失败。");
        return;
      }
      setItems([]);
      setNext(null);
      setTotal(0);
      say("ok", `已清空 ${data.removed ?? 0} 条`);
    } catch {
      say("err", "网络异常，请检查连接后重试。");
    } finally {
      setBusy("");
    }
  };

  const importLocal = async () => {
    const local = readHistory();
    if (local.length === 0) {
      say("ok", "这台浏览器里没有旧记录。");
      return;
    }
    setBusy("import");
    try {
      // at 一律不带：浏览器里只存了文本，编一个时间出来等于伪造历史。
      const res = await fetch(appPath("/api/history/import"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: local.map((q) => ({ query: q })) }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; imported?: number; skipped?: number; message?: string }
        | null;
      if (!res.ok || !data?.ok) {
        say("err", data?.message ?? "导入失败。");
        return;
      }
      say("ok", `从本机导入 ${data.imported ?? 0} 条（${data.skipped ?? 0} 条已存在）`);
      await load({ q: query });
    } catch {
      say("err", "网络异常，请检查连接后重试。");
    } finally {
      setBusy("");
    }
  };

  // 关掉（或还没判定完）时什么都不渲染：见文件头第 1 条。
  if (enabled !== true) {
    if (enabled === null && loading) {
      return <p className="font-mono text-[11px] text-neutral-600">读取中…</p>;
    }
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {notice && (
        <p
          className={
            "rounded border px-3 py-2 text-[12px] " +
            (notice.kind === "ok"
              ? "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-400"
              : "border-red-500/30 bg-red-500/[0.06] text-red-400")
          }
        >
          {notice.text}
        </p>
      )}

      <div className="flex items-center gap-2">
        <input
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setQuery(needle);
              void load({ q: needle });
            }
          }}
          placeholder="搜提问（至少 2 个字）"
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-black px-2 py-1.5 font-mono text-[12px] text-neutral-200 placeholder:text-neutral-700 focus:border-neutral-600 focus:outline-none"
        />
        <button
          type="button"
          className="rounded border border-neutral-800 px-2 py-1.5 font-mono text-[11px] text-neutral-300 transition-colors hover:border-neutral-600 hover:text-white"
          disabled={loading}
          onClick={() => {
            setQuery(needle);
            void load({ q: needle });
          }}
        >
          搜索
        </button>
      </div>

      {loading && items.length === 0 && <p className="font-mono text-[11px] text-neutral-600">读取中…</p>}

      {!loading && items.length === 0 && (
        <p className="font-mono text-[11px] text-neutral-600">
          {query.trim().length >= 2 ? "没有匹配的记录。" : "还没有记录。下一次提问之后，这里会留下它的索引。"}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {items.map((row) => (
          <li key={row.id} className="rounded border border-neutral-800 bg-[#0f0f0f] p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[12px] text-neutral-200">
                  {row.query ? row.query : <span className="text-neutral-600">（这件功能当时关着原文保存）</span>}
                  {row.intentKind === "verify" && <span className="ml-1.5 text-[10px] text-neutral-500">文档核验</span>}
                  {row.intentKind === "import" && <span className="ml-1.5 text-[10px] text-neutral-500">从本机导入</span>}
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-neutral-600">
                  {time(row.at)} · {REGION_TEXT[row.region] ?? row.region} · {countsText(row.counts)}
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-neutral-700">
                  {row.sources} 个信源
                  {row.hosts.length > 0 && <span> · {row.hosts.slice(0, 3).join(" / ")}{row.hosts.length > 3 ? " …" : ""}</span>}
                  {row.degraded.length > 0 && <span className="text-amber-500/80"> · {row.degraded.length} 项降级</span>}
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 rounded border border-red-500/30 px-2 py-1 font-mono text-[10px] text-red-400 transition-colors hover:border-red-500/60 hover:text-red-300"
                disabled={busy === row.id || busy === "all"}
                onClick={() => void remove(row)}
              >
                {busy === row.id ? "删除中…" : "删除"}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {next !== null && (
        <button
          type="button"
          className="rounded border border-neutral-800 px-3 py-1.5 font-mono text-[11px] text-neutral-300 transition-colors hover:border-neutral-600 hover:text-white"
          disabled={loading}
          onClick={() => void load({ append: true, before: next, q: query })}
        >
          {loading ? "读取中…" : "加载更早的"}
        </button>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-neutral-900 pt-3">
        <a
          href={appPath("/api/history/export")}
          className="rounded border border-neutral-800 px-2 py-1.5 font-mono text-[11px] text-neutral-300 transition-colors hover:border-neutral-600 hover:text-white"
        >
          导出 JSON
        </a>
        <button
          type="button"
          className="rounded border border-neutral-800 px-2 py-1.5 font-mono text-[11px] text-neutral-300 transition-colors hover:border-neutral-600 hover:text-white"
          disabled={busy === "import"}
          onClick={() => void importLocal()}
        >
          {busy === "import" ? "导入中…" : "导入本机旧记录"}
        </button>
        <button
          type="button"
          className="rounded border border-red-500/30 px-2 py-1.5 font-mono text-[11px] text-red-400 transition-colors hover:border-red-500/60 hover:text-red-300"
          disabled={busy === "all" || items.length === 0}
          onClick={() => void clearAll()}
        >
          {busy === "all" ? "清空中…" : "清空全部"}
        </button>
        {total !== null && <span className="font-mono text-[10px] text-neutral-700">共 {total} 条</span>}
      </div>

      <p className="font-mono text-[10px] leading-relaxed text-neutral-700">
        这里只存索引：提问、时间、断言计数、读过哪些站。正文与模型输出不落库；删除即从库里消失，保留 30 天。
      </p>
    </div>
  );
}
