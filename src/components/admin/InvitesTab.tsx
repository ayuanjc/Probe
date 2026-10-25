"use client";

import { useMemo, useState } from "react";
import { appPath } from "@/lib/base-path";
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
  type PublicInvite,
  type Role,
} from "./shared";

type Filter = "all" | "live" | "dead";

/**
 * 邀请码页签。
 *
 * 一个必须讲清楚的事实：**码只在生成时存在一次**。库里存的是 sha256(code)，
 * 所以列表里既显示不出码，也拼不出注册链接 —— 想再发一次只能重新生成。
 * 这也是为什么"复制注册链接"按钮只出现在刚生成的那张卡片上。
 */
export default function InvitesTab({
  invites,
  loading,
  reload,
  onSay,
}: {
  invites: PublicInvite[];
  loading: boolean;
  reload: () => Promise<void>;
  onSay: (notice: Notice) => void;
}) {
  const [busy, setBusy] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const [note, setNote] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [uses, setUses] = useState("1");
  const [hours, setHours] = useState("72");
  const [fresh, setFresh] = useState<string | null>(null);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onSay({ kind: "ok", text: "已复制" + label });
    } catch {
      onSay({ kind: "err", text: "复制失败，请手动选中" });
    }
  };

  const state = (inv: PublicInvite): { dead: boolean; label: string } => {
    const expired = inv.expiresAt !== null && inv.expiresAt <= Date.now();
    if (inv.revoked) return { dead: true, label: "已撤销" };
    if (expired) return { dead: true, label: "已过期" };
    if (inv.uses >= inv.maxUses) return { dead: true, label: "已用完" };
    return { dead: false, label: "可用" };
  };

  const counts = useMemo(() => {
    let live = 0;
    for (const inv of invites) if (!state(inv).dead) live += 1;
    return { all: invites.length, live, dead: invites.length - live };
  }, [invites]);

  const visible = useMemo(
    () =>
      invites.filter((inv) => {
        const dead = state(inv).dead;
        if (filter === "live") return !dead;
        if (filter === "dead") return dead;
        return true;
      }),
    [invites, filter],
  );

  const createInvite = async () => {
    if (busy) return;
    /*
     * 次数与有效期必须显式校验，不能让 Number() 的宽容兜底。
     *
     * 原来写的是 `Number(uses) || 1` 与 `Number(hours) > 0 ? Number(hours) : null`：
     * 填 abc → NaN → 悄悄变成「1 次」；填 1e999 → Infinity 通过了 > 0 判断，
     * 而 JSON.stringify(Infinity) 就是 "null" —— 邀请码从「72 小时」变成**永不过期**。
     * 这两条都是「界面明示 A、实际发的是 B」，比直接报错危险得多。
     */
    const usesNum = uses.trim() === "" ? 1 : Number(uses);
    if (!Number.isFinite(usesNum) || !Number.isInteger(usesNum) || usesNum < 1 || usesNum > 100) {
      onSay({ kind: "err", text: "可用次数要填 1–100 的整数。" });
      return;
    }
    const hoursNum = hours.trim() === "" ? null : Number(hours);
    if (hoursNum !== null && (!Number.isFinite(hoursNum) || hoursNum < 1 || hoursNum > 8760)) {
      onSay({ kind: "err", text: "有效期要填 1–8760 小时（一年），留空表示不过期。" });
      return;
    }
    setBusy("create-invite");
    const r = await api<{ code: string }>("/api/admin/invites", {
      method: "POST",
      body: {
        note,
        role,
        maxUses: usesNum,
        expiresInHours: hoursNum,
      },
    });
    setBusy("");
    if (!r.ok || !r.data) {
      onSay({ kind: "err", text: r.message });
      return;
    }
    setFresh(r.data.code);
    setNote("");
    await reload();
  };

  const revokeInvite = async (inv: PublicInvite) => {
    if (!window.confirm("撤销后这个邀请码立刻不可用，已经用它注册的账号不受影响。继续？")) return;
    setBusy(inv.id);
    const r = await api("/api/admin/invites?id=" + encodeURIComponent(inv.id), { method: "DELETE" });
    setBusy("");
    if (!r.ok) {
      onSay({ kind: "err", text: r.message });
      return;
    }
    onSay({ kind: "ok", text: "已撤销" });
    await reload();
  };

  const link = fresh ? appPath("/signup") + "?code=" + encodeURIComponent(fresh) : "";

  return (
    <div className="flex flex-col gap-3">
      <div className={cardClass}>
        <div className="grid gap-2 sm:grid-cols-4">
          <label className="block sm:col-span-2">
            <span className={labelClass}>备注</span>
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="发给谁" />
          </label>
          <label className="block">
            <span className={labelClass}>可用次数</span>
            <input className={inputClass} value={uses} onChange={(e) => setUses(e.target.value)} inputMode="numeric" />
          </label>
          <label className="block">
            <span className={labelClass}>有效小时（≤0 永久）</span>
            <input className={inputClass} value={hours} onChange={(e) => setHours(e.target.value)} inputMode="numeric" />
          </label>
          <label className="block">
            <span className={labelClass}>角色</span>
            <select
              className={inputClass}
              value={role}
              onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "member")}
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

      {fresh && (
        <SecretCard
          title="新邀请码（只显示这一次，库里只存哈希）"
          value={fresh}
          extra={
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" className={btnNeutral} onClick={() => void copy(link, "注册链接")}>
                复制注册链接
              </button>
              <code className="min-w-0 flex-1 break-all font-mono text-[10px] text-amber-500/70">{link}</code>
            </div>
          }
          onCopy={() => void copy(fresh, "邀请码")}
          onDismiss={() => setFresh(null)}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["all", "全部", counts.all],
            ["live", "可用", counts.live],
            ["dead", "已失效", counts.dead],
          ] as [Filter, string, number][]
        ).map(([key, label, n]) => (
          <Chip key={key} active={filter === key} onClick={() => setFilter(key)} count={n}>
            {label}
          </Chip>
        ))}
        <span className="ml-auto font-mono text-[10px] text-neutral-600">
          已发出的码无法再次查看，只保留哈希
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-[12px]">
          <thead>
            <tr className={tableHeadClass}>
              <th className={thClass}>备注</th>
              <th className={thClass}>角色</th>
              <th className={thClass}>已用 / 上限</th>
              <th className={thClass}>过期</th>
              <th className={thClass}>状态</th>
              <th className={thClass}>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((inv) => {
              const s = state(inv);
              return (
                <tr key={inv.id} className={rowClass}>
                  <td className="py-2 pr-2 text-neutral-300">{inv.note || "—"}</td>
                  <td className="py-2 pr-2 text-neutral-500">{inv.role === "admin" ? "管理员" : "用户"}</td>
                  <td className="py-2 pr-2 font-mono tabular-nums text-neutral-500">
                    {inv.uses} / {inv.maxUses}
                  </td>
                  <td className="py-2 pr-2 font-mono text-[11px] text-neutral-500">
                    {inv.expiresAt === null ? "永久" : time(inv.expiresAt)}
                  </td>
                  <td className="py-2 pr-2">
                    <span className={s.dead ? "text-neutral-600" : "text-emerald-500"}>{s.label}</span>
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
            {visible.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className={emptyClass}>
                  {invites.length === 0 ? "还没有邀请码。生成一个发给测试用户。" : "没有匹配的邀请码。"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
