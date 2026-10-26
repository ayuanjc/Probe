"use client";

import { useCallback, useEffect, useState } from "react";
import { appPath } from "@/lib/base-path";
import { providerLabel } from "@/lib/provider-label";
import { time, type Notice } from "./admin/shared";

/**
 * 我的关注（/account 页）：关注了谁 + 谁在提它。
 *
 * 四条口径：
 *   1. **服务器没开就整块不渲染** —— 和 AccountHistory 一致，空列表会被读成「你把我的关注删了」。
 *   2. **未读数是这个面板的全部意义** —— 命中列表默认只看未读，读完就沉下去；
 *      没有未读数，关注就退化成又一个 RSS。
 *   3. **点开即已读** —— 点链接触发一次 mark read，但不等它返回就跳转（跳转比计费重要）。
 *   4. **命中的标题是原文标题**，不是我们改写的；脱离开原文的「命中」等于造谣。
 */

type WatchItem = { id: string; name: string; key: string; kind: string; createdAt: number; hits: number; unread: number; lastSeenAt: number | null };
type HitItem = {
  id: string;
  watchId: string;
  watchName: string;
  url: string;
  title: string | null;
  host: string | null;
  provider: string | null;
  points: number;
  seenAt: string | null;
  at: number;
  read: boolean;
};

type WatchResponse = { ok?: boolean; enabled?: boolean; items?: WatchItem[]; unread?: number; message?: string };
type HitResponse = { ok?: boolean; enabled?: boolean; items?: HitItem[]; unread?: number; message?: string };

const KIND_TEXT: Record<string, string> = {
  org: "公司",
  tech: "技术",
  person: "人物",
  geo: "地区",
  event: "事件",
  other: "其他",
};

export default function WatchPanel() {
  const [watches, setWatches] = useState<WatchItem[]>([]);
  const [hits, setHits] = useState<HitItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [name, setName] = useState("");
  const [suggest, setSuggest] = useState<string[]>([]);
  const [onlyUnread, setOnlyUnread] = useState(true);
  const [filterWatch, setFilterWatch] = useState<string>("");

  const say = (kind: Notice["kind"], text: string) => setNotice({ kind, text });

  const loadWatches = useCallback(async () => {
    const res = await fetch(appPath("/api/watch"), { cache: "no-store" });
    const data = (await res.json().catch(() => null)) as WatchResponse | null;
    if (!data) {
      say("err", "服务器返回的不是 JSON，稍后重试。");
      return false;
    }
    if (data.enabled === false) {
      setEnabled(false);
      return false;
    }
    setEnabled(true);
    setWatches(data.items ?? []);
    setUnread(typeof data.unread === "number" ? data.unread : 0);
    return true;
  }, []);

  const loadHits = useCallback(async (opts: { unreadOnly: boolean; watchId: string }) => {
    const params = new URLSearchParams({ limit: "30" });
    if (opts.unreadOnly) params.set("unread", "1");
    if (opts.watchId) params.set("watch", opts.watchId);
    const res = await fetch(appPath("/api/watch/hits") + "?" + params.toString(), { cache: "no-store" });
    const data = (await res.json().catch(() => null)) as HitResponse | null;
    if (!data || data.enabled === false) return;
    setHits(data.items ?? []);
    if (typeof data.unread === "number") setUnread(data.unread);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      try {
        const ok = await loadWatches();
        if (alive && ok) {
          await loadHits({ unreadOnly: true, watchId: "" });
          const res = await fetch(appPath("/api/watch/suggest"), { cache: "no-store" });
          const data = (await res.json().catch(() => null)) as { ok?: boolean; items?: string[] } | null;
          if (alive && data?.ok) setSuggest((data.items ?? []).slice(0, 4));
        }
      } catch {
        if (alive) say("err", "网络异常，请检查连接后重试。");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadWatches, loadHits]);

  const add = async (raw: string) => {
    const target = raw.trim();
    if (target.length < 2) {
      say("err", "至少两个字。");
      return;
    }
    setBusy("add");
    try {
      const res = await fetch(appPath("/api/watch"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: target }),
      });
      const data = (await res.json().catch(() => null)) as WatchResponse & { created?: boolean } | null;
      if (!res.ok || !data?.ok) {
        say("err", data?.message ?? "添加失败。");
        return;
      }
      setName("");
      setSuggest((prev) => prev.filter((s) => s !== target));
      await loadWatches();
      say("ok", data.created === false ? "已经在关注里了。" : "已关注「" + target + "」。下一轮热榜开始匹配。");
    } catch {
      say("err", "网络异常，请检查连接后重试。");
    } finally {
      setBusy("");
    }
  };

  const remove = async (item: WatchItem) => {
    if (!window.confirm("不再关注「" + item.name + "」？命中记录会一起删掉。")) return;
    setBusy(item.id);
    try {
      const res = await fetch(appPath("/api/watch") + "?id=" + encodeURIComponent(item.id), { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!res.ok || !data?.ok) {
        say("err", data?.message ?? "删除失败。");
        return;
      }
      setWatches((prev) => prev.filter((w) => w.id !== item.id));
      if (filterWatch === item.id) {
        setFilterWatch("");
        await loadHits({ unreadOnly: onlyUnread, watchId: "" });
      }
      say("ok", "已取消关注");
    } catch {
      say("err", "网络异常，请检查连接后重试。");
    } finally {
      setBusy("");
    }
  };

  const markAll = async () => {
    setBusy("read");
    try {
      const res = await fetch(appPath("/api/watch/read"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true, watch: filterWatch || undefined }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; changed?: number; message?: string } | null;
      if (!res.ok || !data?.ok) {
        say("err", data?.message ?? "标记失败。");
        return;
      }
      setHits((prev) => prev.map((h) => ({ ...h, read: true })));
      setUnread((n) => Math.max(0, n - (data.changed ?? 0)));
      await loadWatches();
      say("ok", "未读已清空");
    } catch {
      say("err", "网络异常，请检查连接后重试。");
    } finally {
      setBusy("");
    }
  };

  /** 点开即已读：不等返回就跳转 —— 用户要的是看到原文，不是看到「已标记」。 */
  const openHit = (hit: HitItem) => {
    if (!hit.read) {
      void fetch(appPath("/api/watch/read"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [hit.id] }),
      }).catch(() => undefined);
      setHits((prev) => prev.filter((h) => (onlyUnread ? h.id !== hit.id : true)).map((h) => (h.id === hit.id ? { ...h, read: true } : h)));
      setUnread((n) => Math.max(0, n - 1));
    }
  };

  if (enabled === false) return null;

  return (
    <div className="flex flex-col gap-3">
      {/* 添加 */}
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add(name);
          }}
          placeholder="公司 / 技术 / 人，例如 台积电"
          maxLength={40}
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-black px-2 py-1.5 font-mono text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void add(name)}
          disabled={busy !== "" || name.trim().length < 2}
          className="shrink-0 rounded border border-neutral-700 px-2.5 py-1.5 font-mono text-[11px] text-neutral-300 transition-colors hover:border-neutral-500 hover:text-white disabled:opacity-40"
        >
          关注
        </button>
      </div>

      {suggest.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] text-neutral-600">你最近常搜：</span>
          {suggest.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void add(s)}
              disabled={busy !== ""}
              className="rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white disabled:opacity-40"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {notice && (
        <p className={"font-mono text-[10px] " + (notice.kind === "err" ? "text-red-400" : "text-emerald-400")}>
          {notice.text}
        </p>
      )}

      {loading ? (
        <p className="font-mono text-[10px] text-neutral-600">读取中…</p>
      ) : watches.length === 0 ? (
        <p className="font-mono text-[10px] leading-relaxed text-neutral-600">
          还没有关注。加一个之后，每次热榜刷新都会在命中里出现相关的条目 ——
          只推标题和链接，判断留给你。
        </p>
      ) : (
        <>
          {/* 关注列表 */}
          <ul className="flex flex-col divide-y divide-neutral-900 rounded border border-neutral-800">
            {watches.map((w) => (
              <li key={w.id} className="flex items-center gap-2 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => {
                    const next = filterWatch === w.id ? "" : w.id;
                    setFilterWatch(next);
                    void loadHits({ unreadOnly: onlyUnread, watchId: next });
                  }}
                  className={"truncate text-left font-mono text-[12px] transition-colors " + (filterWatch === w.id ? "text-blue-400" : "text-neutral-300 hover:text-white")}
                  title="只看这个关注的命中"
                >
                  {w.name}
                </button>
                <span className="shrink-0 font-mono text-[10px] text-neutral-600">{KIND_TEXT[w.kind] ?? w.kind}</span>
                {w.unread > 0 && (
                  <span className="shrink-0 rounded bg-blue-500/15 px-1.5 font-mono text-[10px] text-blue-300">{w.unread}</span>
                )}
                <span className="ml-auto shrink-0 font-mono text-[10px] text-neutral-600">
                  {w.hits} 条{w.lastSeenAt ? " · " + time(w.lastSeenAt) : ""}
                </span>
                <button
                  type="button"
                  onClick={() => void remove(w)}
                  disabled={busy !== ""}
                  className="shrink-0 font-mono text-[10px] text-neutral-600 transition-colors hover:text-red-400 disabled:opacity-40"
                  aria-label={"取消关注 " + w.name}
                >
                  删
                </button>
              </li>
            ))}
          </ul>

          {/* 命中 */}
          <div className="flex items-center gap-3 font-mono text-[10px] text-neutral-600">
            <button
              type="button"
              onClick={() => {
                const next = !onlyUnread;
                setOnlyUnread(next);
                void loadHits({ unreadOnly: next, watchId: filterWatch });
              }}
              className="transition-colors hover:text-white"
            >
              {onlyUnread ? "只看未读（点此看全部）" : "全部命中（点此只看未读）"}
            </button>
            <button
              type="button"
              onClick={() => void loadHits({ unreadOnly: onlyUnread, watchId: filterWatch })}
              className="transition-colors hover:text-white"
            >
              刷新
            </button>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAll()}
                disabled={busy !== ""}
                className="ml-auto text-blue-400 transition-colors hover:text-blue-300 disabled:opacity-40"
              >
                全部标记已读
              </button>
            )}
          </div>

          {hits.length === 0 ? (
            <p className="font-mono text-[10px] leading-relaxed text-neutral-600">
              {onlyUnread ? "没有未读命中。" : "还没有命中。"}
              热榜每 5 分钟算一次，命中要等下一轮。
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-900 rounded border border-neutral-800">
              {hits.map((h) => (
                <li key={h.id} className="flex flex-col gap-0.5 px-2 py-1.5">
                  <a
                    href={h.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={() => openHit(h)}
                    className={"text-[12px] leading-snug transition-colors " + (h.read ? "text-neutral-500 hover:text-neutral-300" : "text-neutral-200 hover:text-white")}
                  >
                    {h.title ?? h.url}
                  </a>
                  <span className="font-mono text-[10px] text-neutral-600">
                    {h.watchName} · {h.host ?? "未知来源"}
                    {h.provider ? " · " + providerLabel(h.provider) : ""}
                    {h.points > 0 ? " · " + h.points + " 分" : ""} · {time(h.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <p className="font-mono text-[10px] leading-relaxed text-neutral-700">
        只推标题与链接，不推正文、不发邮件。歧义词（苹果、小米、长城这类）没有上下文就不推 ——
        推错一次的代价比漏一次高。
      </p>
    </div>
  );
}
