"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AdminShell, { type AdminNavGroup } from "./admin/AdminShell";
import AuditTab from "./admin/AuditTab";
import InvitesTab from "./admin/InvitesTab";
import QuotaTab from "./admin/QuotaTab";
import SessionsDrawer from "./admin/SessionsDrawer";
import SettingsTab from "./admin/SettingsTab";
import UsersTab from "./admin/UsersTab";
import type { OpsReport } from "@/lib/ops-report";
import {
  api,
  btnNeutral,
  NoticeBanner,
  type AuditEntry,
  type Notice,
  type PublicInvite,
  type PublicUser,
} from "./admin/shared";

type Tab = "users" | "invites" | "audit" | "quota" | "settings";

const TAB_TITLE: Record<Tab, string> = {
  users: "用户",
  invites: "邀请码",
  audit: "审计",
  quota: "额度设置",
  settings: "设置",
};

/**
 * 后台管理台外壳：左侧导航 + 分区内容 + 一条通知。
 *
 * 这个组件**不承担**任何安全职责 —— 所有动作打到 /api/admin/*，服务端自己校验 admin。
 * 就算有人改了前端去点按钮，服务端照样 403。这里只决定"把哪些操作排出来"。
 *
 * 分区拆在 ./admin/ 下：用户（含设备抽屉）、邀请码、审计、额度设置、设置。
 * 「额度」与「设置」单独一组：前三个是日常操作，后两个一改就是全站生效。
 */
export default function AdminConsole({ me }: { me: { id: string; username: string } }) {
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [invites, setInvites] = useState<PublicInvite[]>([]);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [ops, setOps] = useState<OpsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sessionUser, setSessionUser] = useState<PublicUser | null>(null);

  /** 提示条的自动消失计时器：连续两次操作时，前一个 timer 不能把后一条提示提前清掉。 */
  const noticeTimer = useRef<number | null>(null);

  const say = useCallback((next: Notice) => {
    setNotice(next);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    if (next.kind === "ok") {
      noticeTimer.current = window.setTimeout(() => {
        noticeTimer.current = null;
        setNotice(null);
      }, 4000);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  const loadUsers = useCallback(async () => {
    const r = await api<{ users: PublicUser[] }>("/api/admin/users");
    if (r.ok && r.data) setUsers(r.data.users);
    else say({ kind: "err", text: r.message });
  }, [say]);

  const loadInvites = useCallback(async () => {
    const r = await api<{ invites: PublicInvite[] }>("/api/admin/invites");
    if (r.ok && r.data) setInvites(r.data.invites);
  }, []);

  const loadAudit = useCallback(async () => {
    const r = await api<{ entries: AuditEntry[] }>("/api/admin/audit?limit=200");
    if (r.ok && r.data) setEntries(r.data.entries);
  }, []);

  const loadOps = useCallback(async () => {
    const r = await api<{ ok: boolean; report: OpsReport }>("/api/admin/ops");
    if (r.ok && r.data?.report) setOps(r.data.report);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadUsers(), loadInvites(), loadAudit(), loadOps()]);
    setLoading(false);
  }, [loadUsers, loadInvites, loadAudit, loadOps]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 改完用户后：列表 + 审计都要重读（动作都留痕）；额度也可能因为改账号角色而变化。 */
  const reloadAfterMutation = useCallback(async () => {
    await Promise.all([loadUsers(), loadInvites(), loadAudit(), loadOps()]);
    // 抽屉开着就同步那份数据，否则关掉再开才更新。
    if (sessionUser) {
      const fresh = users.find((u) => u.id === sessionUser.id);
      if (fresh) setSessionUser(fresh);
    }
  }, [loadUsers, loadInvites, loadAudit, loadOps, sessionUser, users]);

  const groups: AdminNavGroup[] = [
    {
      title: "管理",
      items: [
        { key: "users", label: "用户", hint: String(users.length) },
        { key: "invites", label: "邀请码", hint: String(invites.length) },
        { key: "audit", label: "审计" },
      ],
    },
    {
      title: "系统",
      items: [
        {
          key: "quota",
          label: "额度设置",
          hint: ops ? ops.quota.global.used + "/" + ops.quota.global.cap : undefined,
          tone: "warn",
        },
        { key: "settings", label: "设置", tone: "warn" },
      ],
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 md:hidden">
        <span className="font-mono text-[11px] text-neutral-400">{TAB_TITLE[tab]}</span>
        <button type="button" onClick={() => void refresh()} className={btnNeutral} disabled={loading}>
          {loading ? "读取中…" : "刷新"}
        </button>
      </div>

      <AdminShell
        groups={groups}
        active={tab}
        onPick={(key) => setTab(key as Tab)}
        actions={
          <button type="button" onClick={() => void refresh()} className={btnNeutral + " w-full"} disabled={loading}>
            {loading ? "读取中…" : "刷新"}
          </button>
        }
      >
        <div className="flex flex-col gap-4">
          <NoticeBanner notice={notice} />

          {tab === "users" && (
            <UsersTab
              users={users}
              me={me}
              loading={loading}
              reload={reloadAfterMutation}
              onSay={say}
              onOpenSessions={(user) => setSessionUser(user)}
            />
          )}

          {tab === "invites" && (
            <InvitesTab invites={invites} loading={loading} reload={reloadAfterMutation} onSay={say} />
          )}

          {tab === "audit" && <AuditTab entries={entries} loading={loading} />}

          {tab === "quota" && <QuotaTab report={ops} loading={loading} onReport={setOps} onSay={say} />}

          {tab === "settings" && (
            <SettingsTab
              report={ops}
              loading={loading}
              users={users}
              me={me}
              onSay={say}
              onReport={setOps}
              onChanged={reloadAfterMutation}
            />
          )}
        </div>
      </AdminShell>

      {sessionUser && (
        <SessionsDrawer
          userId={sessionUser.id}
          username={sessionUser.username}
          selfId={me.id}
          onClose={() => {
            setSessionUser(null);
            void loadUsers();
          }}
          onSay={say}
        />
      )}
    </div>
  );
}
