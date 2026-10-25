"use client";

import type { ReactNode } from "react";

/**
 * 后台左侧导航外壳。
 *
 * 为什么从「一排页签按钮」改成侧边栏：页签在横向到五个之后就挤成一团，
 * 而且分区信息（哪些是日常管理、哪些是部署/额度这类危险区）完全表达不出来。
 * 侧边栏可以把「管理」和「系统」分开 —— 点错一个邀请码按钮只是麻烦，
 * 点错一个额度按钮会让全站模型调用停摆，这两类操作不该长得一样。
 *
 * 只做布局，不碰数据：活跃项与切换由 AdminConsole 传进来。
 */
export type AdminNavItem = {
  key: string;
  label: string;
  /** 右侧的小字（数量 / 警示）。 */
  hint?: string;
  /** 危险区：写在下面而不是靠红色把整块都染红。 */
  tone?: "normal" | "warn";
};

export type AdminNavGroup = { title: string; items: AdminNavItem[] };

export default function AdminShell({
  groups,
  active,
  onPick,
  actions,
  children,
}: {
  groups: AdminNavGroup[];
  active: string;
  onPick: (key: string) => void;
  /** 刷新之类的全局动作，贴在导航底部。 */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-[180px_minmax(0,1fr)] md:gap-6">
      <nav
        aria-label="后台分区"
        className="flex gap-1 overflow-x-auto pb-1 md:sticky md:top-4 md:flex-col md:gap-4 md:self-start md:overflow-visible md:pb-0"
      >
        {groups.map((group) => (
          <div key={group.title} className="flex shrink-0 gap-1 md:flex-col md:gap-0.5">
            <p className="hidden px-2.5 pb-1 font-mono text-[10px] uppercase tracking-wide text-neutral-600 md:block">
              {group.title}
            </p>
            {group.items.map((item) => {
              const isActive = item.key === active;
              const warn = item.tone === "warn";
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onPick(item.key)}
                  aria-current={isActive ? "page" : undefined}
                  className={[
                    "flex shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded border px-2.5 py-1.5 text-left font-mono text-[11px] transition-colors",
                    isActive
                      ? warn
                        ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
                        : "border-blue-500/50 bg-blue-500/10 text-blue-400"
                      : "border-transparent text-neutral-500 hover:text-white",
                  ].join(" ")}
                >
                  <span>{item.label}</span>
                  {item.hint ? (
                    <span className={isActive ? "text-[10px] opacity-80" : "text-[10px] text-neutral-600"}>
                      {item.hint}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
        {actions ? <div className="hidden md:mt-auto md:block md:pt-3">{actions}</div> : null}
      </nav>

      <div className="min-w-0">{children}</div>
    </div>
  );
}
