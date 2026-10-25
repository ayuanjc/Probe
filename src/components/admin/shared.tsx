"use client";

import type { ReactNode } from "react";
import { appPath } from "@/lib/base-path";

/**
 * 后台管理台的共享件：类型、请求、格式化、样式常量，以及三个小展示块。
 *
 * 单独拎出来的原因是——拆分页签之后，这四样东西每个页签都要用。
 * 样式常量只此一份，改配色不用满项目找。
 */

export type Role = "admin" | "member";
export type UserStatus = "active" | "disabled";

export type PublicUser = {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  createdAt: number;
  createdBy: string;
  lastLoginAt: number | null;
  mustChangePassword: boolean;
  note: string;
  usage: { day: string; calls: number };
  sessions: number;
};

export type PublicInvite = {
  id: string;
  note: string;
  role: Role;
  maxUses: number;
  uses: number;
  expiresAt: number | null;
  createdAt: number;
  createdBy: string;
  revoked: boolean;
  usedBy: { userId: string; at: number }[];
};

export type AuditEntry = { at: number; actor: string; action: string; target: string; detail: string };

/** 会话对外视图：只有 ipHash 指纹，没有 token。 */
export type PublicSession = {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ipHash: string;
  userAgent: string;
  live: boolean;
};

export type Notice = { kind: "ok" | "err"; text: string };

export function time(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间：设备列表里"最后活跃"用绝对时间不好读。 */
export function since(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return time(ts);
}

/** 登录设备里展示的浏览器摘要：完整 UA 太长，截断会失去分辨力，先压成"系统 · 浏览器"。 */
export function deviceLabel(userAgent: string): string {
  const ua = userAgent || "";
  const os = /Windows/i.test(ua)
    ? "Windows"
    : /Android/i.test(ua)
      ? "Android"
      : /iPhone|iPad|iOS/i.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "未知系统";
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /OPR\//i.test(ua)
      ? "Opera"
      : /Firefox\//i.test(ua)
        ? "Firefox"
        : /Chrome\//i.test(ua)
          ? "Chrome"
          : /Safari\//i.test(ua)
            ? "Safari"
            : /curl|node|python|Go-http/i.test(ua)
              ? "命令行"
              : "未知浏览器";
  return os + " · " + browser;
}

export async function api<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data: T | null; message: string }> {
  const res = await fetch(appPath(path), {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const message =
    data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string"
      ? (data as { message: string }).message
      : res.ok
        ? ""
        : `请求失败（${res.status}）`;
  return { ok: res.ok, status: res.status, data: data as T | null, message };
}

export const inputClass =
  "w-full rounded border border-neutral-800 bg-black px-2.5 py-1.5 text-[12px] text-neutral-100 outline-none transition-colors placeholder:text-neutral-700 focus:border-blue-500/60";
export const labelClass = "mb-1 block font-mono text-[10px] text-neutral-500";
export const btnBase = "rounded border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-40";
export const btnNeutral = btnBase + " border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white";
export const btnPrimary = btnBase + " border-blue-500/50 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20";
export const btnDanger = btnBase + " border-red-500/40 text-red-400 hover:bg-red-500/10";
export const cardClass = "rounded border border-neutral-800 bg-[#0f0f0f] p-3";
export const thClass = "py-1.5 pr-2 font-normal";
export const tableHeadClass = "border-b border-neutral-800 text-left font-mono text-[10px] text-neutral-600";
export const rowClass = "border-b border-neutral-900";
export const emptyClass = "py-4 font-mono text-[11px] text-neutral-600";

export function NoticeBanner({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
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
  );
}

/**
 * 一次性凭据展示（初始密码 / 邀请码）。
 * 服务端只存哈希，这两个值在库里找不到第二份 —— 关掉这块就再也看不到了。
 */
export function SecretCard({
  title,
  value,
  extra,
  onCopy,
  onDismiss,
}: {
  title: ReactNode;
  value: string;
  extra?: ReactNode;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded border border-amber-500/40 bg-amber-500/[0.06] p-3">
      <p className="text-[12px] text-amber-300">{title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="min-w-[220px] flex-1 select-all break-all rounded bg-black px-2 py-1.5 font-mono text-[13px] text-amber-200">
          {value}
        </code>
        <button type="button" className={btnNeutral} onClick={onCopy}>
          复制
        </button>
        <button type="button" className={btnNeutral} onClick={onDismiss}>
          已记下
        </button>
      </div>
      {extra}
    </div>
  );
}

/** 可点的筛选片：后台三个页签的筛选共用一个外形。 */
export function Chip({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        btnBase +
        " " +
        (active
          ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
          : "border-neutral-800 text-neutral-500 hover:text-white")
      }
    >
      {children}
      {typeof count === "number" && <span className="ml-1 tabular-nums opacity-60">{count}</span>}
    </button>
  );
}
