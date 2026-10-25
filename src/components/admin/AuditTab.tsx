"use client";

import { useMemo, useState } from "react";
import { Chip, emptyClass, inputClass, rowClass, tableHeadClass, thClass, time, type AuditEntry } from "./shared";

type Group = "all" | "login" | "user" | "invite" | "session" | "risk";

const GROUPS: { key: Group; label: string; match: (action: string) => boolean }[] = [
  { key: "all", label: "全部", match: () => true },
  { key: "login", label: "登录", match: (a) => a.startsWith("login") || a.startsWith("signup") },
  { key: "user", label: "用户", match: (a) => a.startsWith("user_") || a.startsWith("password") },
  { key: "invite", label: "邀请码", match: (a) => a.startsWith("invite") },
  { key: "session", label: "会话", match: (a) => a.startsWith("session_") },
  {
    key: "risk",
    label: "可疑",
    match: (a) => a.includes("failed") || a.includes("rejected") || a.endsWith("_deleted"),
  },
];

/**
 * 审计页签：前端过滤（后端一次给 200 条，够看）。
 * 关键词同时匹配操作者 / 动作 / 对象 / 细节，省掉"到底该搜哪一列"的犹豫。
 */
export default function AuditTab({ entries, loading }: { entries: AuditEntry[]; loading: boolean }) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<Group>("all");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rule = GROUPS.find((g) => g.key === group) ?? GROUPS[0];
    return entries.filter((e) => {
      if (!rule.match(e.action)) return false;
      if (!q) return true;
      // 字段可能缺失（旧记录），toLowerCase 直接调会抛，整页变白。
      const safe = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");
      return (
        safe(e.actor).includes(q) ||
        safe(e.action).includes(q) ||
        safe(e.target).includes(q) ||
        safe(e.detail).includes(q)
      );
    });
  }, [entries, query, group]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={inputClass + " max-w-[260px]"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索操作者 / 动作 / 对象 / 细节"
        />
        {GROUPS.map((g) => (
          <Chip key={g.key} active={group === g.key} onClick={() => setGroup(g.key)}>
            {g.label}
          </Chip>
        ))}
        <span className="ml-auto font-mono text-[10px] text-neutral-600">
          最近 {entries.length} 条 / 命中 {visible.length} 条
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-[12px]">
          <thead>
            <tr className={tableHeadClass}>
              <th className={thClass}>时间</th>
              <th className={thClass}>操作者</th>
              <th className={thClass}>动作</th>
              <th className={thClass}>对象</th>
              <th className={thClass}>细节</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((e, i) => (
              <tr key={`${e.at}-${i}`} className={rowClass}>
                <td className="py-1.5 pr-2 font-mono text-[11px] text-neutral-500">{time(e.at)}</td>
                <td className="py-1.5 pr-2 font-mono text-neutral-300">{e.actor}</td>
                <td className="py-1.5 pr-2">
                  <span
                    className={
                      e.action.includes("failed") || e.action.includes("rejected")
                        ? "text-amber-500"
                        : e.action.startsWith("user_deleted") || e.action.endsWith("_all")
                          ? "text-red-400"
                          : "text-neutral-400"
                    }
                  >
                    {e.action}
                  </span>
                </td>
                <td className="py-1.5 pr-2 font-mono text-[11px] text-neutral-500">{e.target || "—"}</td>
                <td className="py-1.5 pr-2 font-mono text-[10px] text-neutral-600">{e.detail || "—"}</td>
              </tr>
            ))}
            {visible.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className={emptyClass}>
                  {entries.length === 0 ? "还没有记录。" : "没有匹配的记录。"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
