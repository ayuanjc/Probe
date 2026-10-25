"use client";

import { useMemo, useState } from "react";
import {
  api,
  btnDanger,
  btnNeutral,
  btnPrimary,
  cardClass,
  Chip,
  emptyClass,
  inputClass,
  labelClass,
  rowClass,
  SecretCard,
  tableHeadClass,
  thClass,
  time,
  type Notice,
  type PublicUser,
  type Role,
} from "./shared";

type Filter = "all" | "admin" | "pending" | "disabled";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "admin", label: "管理员" },
  { key: "pending", label: "待改密码" },
  { key: "disabled", label: "已停用" },
];

/**
 * 用户页签：搜索 / 筛选 / 建号 / 改角色 / 停用 / 重置密码 / 删号 / 看设备。
 *
 * 所有动作仍由服务端裁决（last_admin、self_delete、密码规则都在 account.ts）。
 * 这里做的只是把"点不到"和"点了会出错"提前分开，省掉一半的往返。
 */
export default function UsersTab({
  users,
  me,
  loading,
  reload,
  onSay,
  onOpenSessions,
}: {
  users: PublicUser[];
  me: { id: string; username: string };
  loading: boolean;
  reload: () => Promise<void>;
  onSay: (notice: Notice) => void;
  onOpenSessions: (user: PublicUser) => void;
}) {
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<Role>("member");
  const [newNote, setNewNote] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [generated, setGenerated] = useState<{ username: string; password: string } | null>(null);

  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetValue, setResetValue] = useState("");

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onSay({ kind: "ok", text: "已复制" });
    } catch {
      onSay({ kind: "err", text: "复制失败，请手动选中" });
    }
  };

  const counts = useMemo(
    () => ({
      all: users.length,
      admin: users.filter((u) => u.role === "admin").length,
      pending: users.filter((u) => u.mustChangePassword).length,
      disabled: users.filter((u) => u.status === "disabled").length,
    }),
    [users],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (filter === "admin" && u.role !== "admin") return false;
      if (filter === "pending" && !u.mustChangePassword) return false;
      if (filter === "disabled" && u.status !== "disabled") return false;
      if (!q) return true;
      return u.username.toLowerCase().includes(q) || u.note.toLowerCase().includes(q);
    });
  }, [users, filter, query]);

  const createUser = async () => {
    if (busy) return;
    setBusy("create-user");
    const r = await api<{ user: PublicUser; password?: string }>("/api/admin/users", {
      method: "POST",
      body: { username: newName, role: newRole, note: newNote, password: newPassword || undefined },
    });
    setBusy("");
    if (!r.ok) {
      onSay({ kind: "err", text: r.message });
      return;
    }
    // 生成的密码只在这一次响应里出现：摊在卡片上等管理员复制。
    if (r.data?.password) setGenerated({ username: r.data.user.username, password: r.data.password });
    else onSay({ kind: "ok", text: "已创建 " + (r.data?.user.username ?? "") });
    setNewName("");
    setNewNote("");
    setNewPassword("");
    setShowNew(false);
    await reload();
  };

  /** 返回是否真的改成功了：调用方要靠它决定「清空输入 / 收起输入行」能不能做。 */
  const patchUser = async (
    id: string,
    patch: Record<string, unknown>,
    label: string,
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(id + label);
    const r = await api("/api/admin/users", { method: "PATCH", body: { id, ...patch } });
    setBusy("");
    if (!r.ok) {
      onSay({ kind: "err", text: r.message });
      return false;
    }
    onSay({ kind: "ok", text: "已" + label });
    await reload();
    return true;
  };

  const removeUser = async (user: PublicUser) => {
    if (!window.confirm(`删除用户 ${user.username}？他的会话会立刻失效，这个操作不可撤销。`)) return;
    setBusy(user.id + "delete");
    const r = await api("/api/admin/users?id=" + encodeURIComponent(user.id), { method: "DELETE" });
    setBusy("");
    if (!r.ok) {
      onSay({ kind: "err", text: r.message });
      return;
    }
    onSay({ kind: "ok", text: "已删除 " + user.username });
    await reload();
  };

  const resetPassword = async (user: PublicUser) => {
    if (resetValue.length < 10) {
      onSay({ kind: "err", text: "新密码至少 10 位。" });
      return;
    }
    /*
     * 失败时不能清空。
     *
     * 原来无条件清空并收起输入行：管理员输了 20 位密码、服务端 400/500 回来，
     * 界面上唯一的痕迹就是一闪而过的提示，输入框已经空了 —— 他只会以为密码改了。
     */
    const ok = await patchUser(user.id, { newPassword: resetValue }, "重置密码");
    if (!ok) return;
    setResetFor(null);
    setResetValue("");
  };

  // "可用管理员"只算正常状态的管理员：停用的管理员撑不起 last_admin 保护。
  const activeAdmins = users.filter((u) => u.role === "admin" && u.status === "active").length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimary} onClick={() => setShowNew((v) => !v)}>
          {showNew ? "收起" : "＋ 添加用户"}
        </button>
        <input
          className={inputClass + " max-w-[220px]"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索用户名或备注"
        />
        {FILTERS.map((f) => (
          <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)} count={counts[f.key]}>
            {f.label}
          </Chip>
        ))}
        <span className="ml-auto font-mono text-[10px] text-neutral-600">
          当前登录 {me.username} · 可用管理员 {activeAdmins} 个
        </span>
      </div>

      {generated && (
        <SecretCard
          title={
            <>
              用户 <span className="font-mono">{generated.username}</span> 的初始密码（只显示这一次）：
            </>
          }
          value={generated.password}
          extra={<p className="mt-2 text-[11px] text-amber-500/80">他登录后会先被要求改成自己的密码。</p>}
          onCopy={() => void copy(generated.password)}
          onDismiss={() => setGenerated(null)}
        />
      )}

      {showNew && (
        <div className={cardClass}>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>用户名</span>
              <input
                className={inputClass}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="test-user-01"
              />
            </label>
            <label className="block">
              <span className={labelClass}>角色</span>
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
              <span className={labelClass}>备注</span>
              <input
                className={inputClass}
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="给谁用、用到什么时候"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className={labelClass}>初始密码（留空自动生成）</span>
              <input
                className={inputClass}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="至少 10 位，留空更省事"
              />
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
        <table className="w-full min-w-[820px] border-collapse text-[12px]">
          <thead>
            <tr className={tableHeadClass}>
              <th className={thClass}>用户</th>
              <th className={thClass}>角色</th>
              <th className={thClass}>状态</th>
              <th className={thClass}>今日调用</th>
              <th className={thClass}>设备</th>
              <th className={thClass}>最近登录</th>
              <th className={thClass}>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((u) => (
              <tr key={u.id} className={rowClass + " align-top"}>
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
                <td className="py-2 pr-2">
                  <button
                    type="button"
                    className={btnNeutral + " tabular-nums"}
                    title="查看/撤销这个用户的登录设备"
                    onClick={() => onOpenSessions(u)}
                  >
                    {u.sessions} 台
                  </button>
                </td>
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
            {visible.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className={emptyClass}>
                  {users.length === 0
                    ? "还没有用户。用上面的「添加用户」建第一个，或者设置 PROBE_ADMIN_USER / PROBE_ADMIN_PASSWORD 重启一次。"
                    : "没有匹配的用户。"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
