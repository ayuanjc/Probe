"use client";

import { useCallback, useEffect, useState } from "react";
import { appPath } from "@/lib/base-path";

/**
 * 后台管理台：用户 / 邀请码 / 审计三块。
 *
 * 全部动作都打 /api/admin/*，由服务端做 admin 校验 —— 这个组件**不承担**任何安全职责，
 * 它只是把"能做哪些操作"排开。就算有人改了前端代码去点按钮，服务端照样 403。
 */

type PublicUser = {
  id: string;
  username: string;
  role: "admin" | "member";
  status: "active" | "disabled";
  createdAt: number;
  createdBy: string;
  lastLoginAt: number | null;
  mustChangePassword: boolean;
  note: string;
  usage: { day: string; calls: number };
  sessions: number;
};

type PublicInvite = {
  id: string;
  note: string;
  role: "admin" | "member";
  maxUses: number;
  uses: number;
  expiresAt: number | null;
  createdAt: number;
  createdBy: string;
  revoked: boolean;
  usedBy: { userId: string; at: number }[];
};

type AuditEntry = { at: number; actor: string; action: string; target: string; detail: string };

type Tab = "users" | "invites" | "audit";

function time(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function api<T>(
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

const inputClass =
  "w-full rounded border border-neutral-800 bg-black px-2.5 py-1.5 text-[12px] text-neutral-100 outline-none transition-colors placeholder:text-neutral-700 focus:border-blue-500/60";
const btnBase =
  "rounded border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-40";
const btnNeutral = btnBase + " border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white";
const btnPrimary = btnBase + " border-blue-500/50 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20";
const btnDanger = btnBase + " border-red-500/40 text-red-400 hover:bg-red-500/10";

export default function AdminConsole({ me }: { me: { id: string; username: string } }) {
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [invites, setInvites] = useState<PublicInvite[]>([]);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const say = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    if (kind === "ok") window.setTimeout(() => setNotice(null), 4000);
  };

  const loadUsers = useCallback(async () => {
    const r = await api<{ users: PublicUser[] }>("/api/admin/users");
    if (r.ok && r.data) setUsers(r.data.users);
    else if (r.status !== 0) say("err", r.message);
  }, []);

  const loadInvites = useCallback(async () => {
    const r = await api<{ invites: PublicInvite[] }>("/api/admin/invites");
    if (r.ok && r.data) setInvites(r.data.invites);
  }, []);

  const loadAudit = useCallback(async () => {
    const r = await api<{ entries: AuditEntry[] }>("/api/admin/audit?limit=200");
    if (r.ok && r.data) setEntries(r.data.entries);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadUsers(), loadInvites(), loadAudit()]);
    setLoading(false);
  }, [loadUsers, loadInvites, loadAudit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* ------------------------------ 用户操作 ------------------------------ */

  const [showNewUser, setShowNewUser] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<"member" | "admin">("member");
  const [newNote, setNewNote] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const createUser = async () => {
    if (busy) return;
    setBusy("create-user");
    const r = await api<{ user: PublicUser; password?: string }>("/api/admin/users", {
      method: "POST",
      body: { username: newName, role: newRole, note: newNote, password: newPassword || undefined },
    });
    setBusy("");
    if (!r.ok) {
      say("err", r.message);
      return;
    }
    // 生成的密码只在这一次响应里出现：直接摊在提示里，管理员复制走。
    if (r.data?.password) {
      setGenerated({ username: r.data.user.username, password: r.data.password });
    } else {
      say("ok", `已创建 ${r.data?.user.username}`);
    }
    setNewName("");
    setNewNote("");
    setNewPassword("");
    setShowNewUser(false);
    await loadUsers();
    await loadAudit();
  };

  const [generated, setGenerated] = useState<{ username: string; password: string } | null>(null);

  const patchUser = async (id: string, patch: Record<string, unknown>, label: string) => {
    if (busy) return;
    setBusy(id + label);
    const r = await api<{ user: PublicUser }>("/api/admin/users", { method: "PATCH", body: { id, ...patch } });
    setBusy("");
    if (!r.ok) {
      say("err", r.message);
      return;
    }
    say("ok", `已${label}`);
    await loadUsers();
    await loadAudit();
  };

  const removeUser = async (user: PublicUser) => {
    if (!window.confirm(`删除用户 ${user.username}？他的会话会立刻失效，这个操作不可撤销。`)) return;
    setBusy(user.id + "delete");
    const r = await api("/api/admin/users?id=" + encodeURIComponent(user.id), { method: "DELETE" });
    setBusy("");
    if (!r.ok) {
      say("err", r.message);
      return;
    }
    say("ok", `已删除 ${user.username}`);
    await loadUsers();
    await loadAudit();
  };

  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetValue, setResetValue] = useState("");

  const resetPassword = async (user: PublicUser) => {
    if (resetValue.length < 10) {
      say("err", "新密码至少 10 位。");
      return;
    }
    await patchUser(user.id, { newPassword: resetValue }, "重置密码");
    setResetFor(null);
    setResetValue("");
  };

  /* ----------------------------- 邀请码操作 ----------------------------- */

  const [invNote, setInvNote] = useState("");
  const [invRole, setInvRole] = useState<"member" | "admin">("member");
  const [invUses, setInvUses] = useState("1");
  const [invHours, setInvHours] = useState("72");
  const [freshCode, setFreshCode] = useState<string | null>(null);

  const createInvite = async () => {
    if (busy) return;
    setBusy("create-invite");
    const r = await api<{ code: string }>("/api/admin/invites", {
      method: "POST",
      body: {
        note: invNote,
        role: invRole,
        maxUses: Number(invUses) || 1,
        expiresInHours: Number(invHours) > 0 ? Number(invHours) : null,
      },
    });
    setBusy("");
    if (!r.ok || !r.data) {
      say("err", r.message);
      return;
    }
    setFreshCode(r.data.code);
    setInvNote("");
    await loadInvites();
    await loadAudit();
  };

  const revokeInvite = async (invite: PublicInvite) => {
    if (!window.confirm("撤销后这个邀请码立刻不可用，已经用它注册的账号不受影响。继续？")) return;
    setBusy(invite.id);
    const r = await api("/api/admin/invites?id=" + encodeURIComponent(invite.id), { method: "DELETE" });
    setBusy("");
    if (!r.ok) {
      say("err", r.message);
      return;
    }
    say("ok", "已撤销");
    await loadInvites();
    await loadAudit();
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      say("ok", "已复制");
    } catch {
      say("err", "复制失败，请手动选中");
    }
  };

  const adminCount = users.filter((u) => u.role === "admin" && u.status === "active").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["users", `用户 ${users.length}`],
            ["invites", `邀请码 ${invites.length}`],
            ["audit", "审计"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={
              btnBase +
              " " +
              (tab === key
                ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
                : "border-neutral-800 text-neutral-500 hover:text-white")
            }
          >
            {label}
          </button>
        ))}
        <button type="button" onClick={() => void refresh()} className={btnNeutral + " ml-auto"}>
          刷新
        </button>
      </div>

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

      {generated && (
        <div className="rounded border border-amber-500/40 bg-amber-500/[0.06] p-3">
          <p className="text-[12px] text-amber-300">
            用户 <span className="font-mono">{generated.username}</span> 的初始密码（只显示这一次）：
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 select-all rounded bg-black px-2 py-1.5 font-mono text-[13px] text-amber-200">
              {generated.password}
            </code>
            <button type="button" className={btnNeutral} onClick={() => void copy(generated.password)}>
              复制
            </button>
            <button type="button" className={btnNeutral} onClick={() => setGenerated(null)}>
              已记下
            </button>
          </div>
        </div>
      )}

      {loading && <p className="font-mono text-[11px] text-neutral-600">读取中…</p>}

      {/* ------------------------------ 用户 ------------------------------ */}
      {tab === "users" && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <button type="button" className={btnPrimary} onClick={() => setShowNewUser((v) => !v)}>
              {showNewUser ? "收起" : "＋ 添加用户"}
            </button>
            <span className="font-mono text-[10px] text-neutral-600">
              当前登录 {me.username} · 可用管理员 {adminCount} 个
            </span>
          </div>

          {showNewUser && (
            <div className="rounded border border-neutral-800 bg-[#0f0f0f] p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block font-mono text-[10px] text-neutral-500">用户名</span>
                  <input className={inputClass} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="test-user-01" />
                </label>
                <label className="block">
                  <span className="mb-1 block font-mono text-[10px] text-neutral-500">角色</span>
                  <select
                    className={inputClass}
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value === "admin" ? "admin" : "member")}
                  >
                    <option value="member">普通用户</option>
                    <option value="admin">管理员</option>
                  </select>
                </label>
                <label className="block sm:col-span-2">
                  <span className="mb-1 block font-mono text-[10px] text-neutral-500">备注</span>
                  <input className={inputClass} value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="给谁用、用到什么时候" />
                </label>
                <label className="block sm:col-span-2">
                  <span className="mb-1 block font-mono text-[10px] text-neutral-500">
                    初始密码（留空自动生成）
                  </span>
                  <input className={inputClass} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="至少 10 位，留空更省事" />
                </label>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={!newName || busy === "create-user"}
                  onClick={() => void createUser()}
                >
                  {busy === "create-user" ? "创建中…" : "创建"}
                </button>
                <span className="font-mono text-[10px] text-neutral-600">新用户首次登录会被要求改密码</span>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-neutral-800 text-left font-mono text-[10px] text-neutral-600">
                  <th className="py-1.5 pr-2 font-normal">用户</th>
                  <th className="py-1.5 pr-2 font-normal">角色</th>
                  <th className="py-1.5 pr-2 font-normal">状态</th>
                  <th className="py-1.5 pr-2 font-normal">今日调用</th>
                  <th className="py-1.5 pr-2 font-normal">会话</th>
                  <th className="py-1.5 pr-2 font-normal">最近登录</th>
                  <th className="py-1.5 pr-2 font-normal">操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-neutral-900 align-top">
                    <td className="py-2 pr-2">
                      <div className="font-mono text-neutral-200">{u.username}</div>
                      {u.note && <div className="mt-0.5 text-[10px] text-neutral-600">{u.note}</div>}
                      {u.mustChangePassword && (
                        <div className="mt-0.5 font-mono text-[10px] text-amber-500">待改密码</div>
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      <span className={u.role === "admin" ? "text-blue-400" : "text-neutral-500"}>
                        {u.role === "admin" ? "管理员" : "用户"}
                      </span>
                    </td>
                    <td className="py-2 pr-2">
                      <span className={u.status === "active" ? "text-emerald-500" : "text-red-400"}>
                        {u.status === "active" ? "正常" : "已停用"}
                      </span>
                    </td>
                    <td className="py-2 pr-2 font-mono tabular-nums text-neutral-500">{u.usage.calls}</td>
                    <td className="py-2 pr-2 font-mono tabular-nums text-neutral-500">{u.sessions}</td>
                    <td className="py-2 pr-2 font-mono text-[11px] text-neutral-500">{time(u.lastLoginAt)}</td>
                    <td className="py-2 pr-2">
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          className={btnNeutral}
                          disabled={busy === u.id + "切换状态"}
                          onClick={() =>
                            void patchUser(
                              u.id,
                              { status: u.status === "active" ? "disabled" : "active" },
                              "切换状态",
                            )
                          }
                        >
                          {u.status === "active" ? "停用" : "启用"}
                        </button>
                        <button
                          type="button"
                          className={btnNeutral}
                          disabled={busy === u.id + "改角色"}
                          onClick={() =>
                            void patchUser(u.id, { role: u.role === "admin" ? "member" : "admin" }, "改角色")
                          }
                        >
                          {u.role === "admin" ? "降为用户" : "升为管理员"}
                        </button>
                        <button
                          type="button"
                          className={btnNeutral}
                          onClick={() => {
                            setResetFor(resetFor === u.id ? null : u.id);
                            setResetValue("");
                          }}
                        >
                          重置密码
                        </button>
                        {u.id !== me.id && (
                          <button
                            type="button"
                            className={btnDanger}
                            disabled={busy === u.id + "delete"}
                            onClick={() => void removeUser(u)}
                          >
                            删除
                          </button>
                        )}
                      </div>
                      {resetFor === u.id && (
                        <div className="mt-1.5 flex items-center gap-1">
                          <input
                            className={inputClass}
                            value={resetValue}
                            onChange={(e) => setResetValue(e.target.value)}
                            placeholder="新密码（≥10 位）"
                          />
                          <button type="button" className={btnPrimary} onClick={() => void resetPassword(u)}>
                            确定
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && !loading && (
                  <tr>
                    <td colSpan={7} className="py-4 font-mono text-[11px] text-neutral-600">
                      还没有用户。用上面的「添加用户」建第一个，或者设置 PROBE_ADMIN_USER / PROBE_ADMIN_PASSWORD 重启一次。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ----------------------------- 邀请码 ----------------------------- */}
      {tab === "invites" && (
        <div className="flex flex-col gap-3">
          <div className="rounded border border-neutral-800 bg-[#0f0f0f] p-3">
            <div className="grid gap-2 sm:grid-cols-4">
              <label className="block sm:col-span-2">
                <span className="mb-1 block font-mono text-[10px] text-neutral-500">备注</span>
                <input className={inputClass} value={invNote} onChange={(e) => setInvNote(e.target.value)} placeholder="发给谁" />
              </label>
              <label className="block">
                <span className="mb-1 block font-mono text-[10px] text-neutral-500">可用次数</span>
                <input className={inputClass} value={invUses} onChange={(e) => setInvUses(e.target.value)} inputMode="numeric" />
              </label>
              <label className="block">
                <span className="mb-1 block font-mono text-[10px] text-neutral-500">有效小时（≤0 永久）</span>
                <input className={inputClass} value={invHours} onChange={(e) => setInvHours(e.target.value)} inputMode="numeric" />
              </label>
              <label className="block">
                <span className="mb-1 block font-mono text-[10px] text-neutral-500">角色</span>
                <select
                  className={inputClass}
                  value={invRole}
                  onChange={(e) => setInvRole(e.target.value === "admin" ? "admin" : "member")}
                >
                  <option value="member">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
              </label>
              <div className="flex items-end">
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={busy === "create-invite"}
                  onClick={() => void createInvite()}
                >
                  {busy === "create-invite" ? "生成中…" : "生成邀请码"}
                </button>
              </div>
            </div>
          </div>

          {freshCode && (
            <div className="rounded border border-amber-500/40 bg-amber-500/[0.06] p-3">
              <p className="text-[12px] text-amber-300">新邀请码（只显示这一次，库里只存哈希）：</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 select-all rounded bg-black px-2 py-1.5 font-mono text-[13px] text-amber-200">
                  {freshCode}
                </code>
                <button type="button" className={btnNeutral} onClick={() => void copy(freshCode)}>
                  复制
                </button>
                <button type="button" className={btnNeutral} onClick={() => setFreshCode(null)}>
                  已记下
                </button>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-neutral-800 text-left font-mono text-[10px] text-neutral-600">
                  <th className="py-1.5 pr-2 font-normal">备注</th>
                  <th className="py-1.5 pr-2 font-normal">角色</th>
                  <th className="py-1.5 pr-2 font-normal">已用 / 上限</th>
                  <th className="py-1.5 pr-2 font-normal">过期</th>
                  <th className="py-1.5 pr-2 font-normal">状态</th>
                  <th className="py-1.5 pr-2 font-normal">操作</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => {
                  const expired = inv.expiresAt !== null && inv.expiresAt <= Date.now();
                  const dead = inv.revoked || expired || inv.uses >= inv.maxUses;
                  return (
                    <tr key={inv.id} className="border-b border-neutral-900">
                      <td className="py-2 pr-2 text-neutral-300">{inv.note || "—"}</td>
                      <td className="py-2 pr-2 text-neutral-500">{inv.role === "admin" ? "管理员" : "用户"}</td>
                      <td className="py-2 pr-2 font-mono tabular-nums text-neutral-500">
                        {inv.uses} / {inv.maxUses}
                      </td>
                      <td className="py-2 pr-2 font-mono text-[11px] text-neutral-500">
                        {inv.expiresAt === null ? "永久" : time(inv.expiresAt)}
                      </td>
                      <td className="py-2 pr-2">
                        <span className={dead ? "text-neutral-600" : "text-emerald-500"}>
                          {inv.revoked ? "已撤销" : expired ? "已过期" : inv.uses >= inv.maxUses ? "已用完" : "可用"}
                        </span>
                      </td>
                      <td className="py-2 pr-2">
                        {!inv.revoked && (
                          <button
                            type="button"
                            className={btnDanger}
                            disabled={busy === inv.id}
                            onClick={() => void revokeInvite(inv)}
                          >
                            撤销
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {invites.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-4 font-mono text-[11px] text-neutral-600">
                      还没有邀请码。生成一个发给测试用户。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ------------------------------ 审计 ------------------------------ */}
      {tab === "audit" && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-neutral-800 text-left font-mono text-[10px] text-neutral-600">
                <th className="py-1.5 pr-2 font-normal">时间</th>
                <th className="py-1.5 pr-2 font-normal">操作者</th>
                <th className="py-1.5 pr-2 font-normal">动作</th>
                <th className="py-1.5 pr-2 font-normal">对象</th>
                <th className="py-1.5 pr-2 font-normal">细节</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.at}-${i}`} className="border-b border-neutral-900">
                  <td className="py-1.5 pr-2 font-mono text-[11px] text-neutral-500">{time(e.at)}</td>
                  <td className="py-1.5 pr-2 font-mono text-neutral-300">{e.actor}</td>
                  <td className="py-1.5 pr-2">
                    <span
                      className={
                        e.action.includes("failed") || e.action.includes("rejected")
                          ? "text-amber-500"
                          : e.action.startsWith("user_deleted")
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
              {entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 font-mono text-[11px] text-neutral-600">
                    还没有记录。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
