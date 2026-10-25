"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AuditTab from "./admin/AuditTab";
import InvitesTab from "./admin/InvitesTab";
import SessionsDrawer from "./admin/SessionsDrawer";
import UsersTab from "./admin/UsersTab";
import {
  api,
  btnBase,
  btnNeutral,
  NoticeBanner,
  type AuditEntry,
  type Notice,
  type PublicInvite,
  type PublicUser,
} from "./admin/shared";

type Tab = "users" | "invites" | "audit";

/**
 * 后台管理台外壳：三个页签 + 一次统一拉取 + 一条通知。
 *
 * 这个组件**不承担**任何安全职责 —— 所有动作打到 /api/admin/*，服务端自己校验 admin。
 * 就算有人改了前端去点按钮，服务端照样 403。这里只决定"把哪些操作排出来"。
 *
 * 页签拆在 ./admin/ 下：用户（含设备抽屉）、邀请码、审计。
 */
export default function AdminConsole({ me }: { me: { id: string; username: string } }) {
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [invites, setInvites] = useState<PublicInvite[]>([]);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
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

  const refresh = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadUsers(), loadInvites(), loadAudit()]);
    setLoading(false);
  }, [loadUsers, loadInvites, loadAudit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 改完用户后：列表 + 审计都要重读（动作都留痕）。 */
  const reloadAfterMutation = useCallback(async () => {
    await Promise.all([loadUsers(), loadInvites(), loadAudit()]);
    // 抽屉开着就同步那份数据，否则关掉再开才更新。
    if (sessionUser) {
      const fresh = users.find((u) => u.id === sessionUser.id);
      if (fresh) setSessionUser(fresh);
    }
  }, [loadUsers, loadInvites, loadAudit, sessionUser, users]);

  const tabs: [Tab, string][] = [
    ["users", `用户 ${users.length}`],
    ["invites", `邀请码 ${invites.length}`],
    ["audit", "审计"],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map(([key, label]) => (
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
        <button type="button" onClick={() => void refresh()} className={btnNeutral + " ml-auto"} disabled={loading}>
          {loading ? "读取中…" : "刷新"}
        </button>
      </div>

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
