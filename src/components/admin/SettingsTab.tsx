"use client";

import { useEffect, useRef, useState } from "react";
import type { OpsReport } from "@/lib/ops-report";
import QuotaCaps from "./QuotaCaps";
import {
  api,
  btnNeutral,
  btnPrimary,
  cardClass,
  emptyClass,
  inputClass,
  labelClass,
  type Notice,
  type PublicUser,
} from "./shared";

/**
 * 设置：能改的两件事 + 只读的部署态。
 *
 * 可写：
 *   1. 账号密码 —— 走 /api/admin/users 的 PATCH（newPassword），业务规则、强制改密、
 *      撤销会话、审计全在 src/lib/auth/account.ts，这里只做一次前置校验。
 *   2. 额度上限 —— 与「额度设置」页共用同一个组件与同一个 POST /api/admin/ops。
 *
 * 只读：环境变量（模型端点、区域兜底、站点备案号、鉴权模式）。
 * 故意不给写入口 —— 从浏览器改这些等于给 web 进程一个"改自己启动参数"的能力，
 * 拿到 admin 会话就能关掉鉴权、把模型端点指向别处。改它们只有一条路：
 * 服务器上编辑 /opt/probe/probe.env，然后 systemctl restart probe-web。
 */

const REGION_SOURCE_TEXT: Record<string, string> = {
  mode: "PROBE_DEFAULT_REGION 强制指定",
  header: "按请求头（反代注入的国家码）",
  ip: "按来访 IP 属地反查",
  default: "无法判定，用兜底值",
  unknown: "未能判定来源",
};

const MODEL_MODE_TEXT: Record<string, string> = {
  allowed: "放行（端点在本区域的允许列表里）",
  switched: "已切到境内兜底端点",
  blocked: "被区域策略拦下 —— 本轮不会有模型调用",
};

/** 与 src/lib/auth/crypto.ts 的 passwordProblem 同一口径（只是提前一步，服务端仍会再判一次）。 */
function passwordProblem(pwd: string, username: string): string | null {
  if (pwd.length < 10) return "新密码至少 10 位。";
  if (pwd.length > 200) return "新密码最多 200 位。";
  if (pwd.trim() !== pwd) return "新密码首尾不能有空格。";
  if (/\s{2,}/.test(pwd)) return "新密码里不要有连续空格。";
  if (username && pwd.toLowerCase().includes(username.toLowerCase())) return "新密码不能包含用户名。";
  return null;
}

function Row({ label, value, env }: { label: string; value: string; env?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-900 py-1.5 last:border-0">
      <span className="font-mono text-[10px] text-neutral-500">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] text-neutral-200">{value}</span>
        {env ? <span className="font-mono text-[10px] text-neutral-700">{env}</span> : null}
      </span>
    </div>
  );
}

function orMissing(v: string | null): string {
  return v ?? "未配置";
}

export default function SettingsTab({
  report,
  loading,
  users,
  me,
  onSay,
  onReport,
  onChanged,
}: {
  report: OpsReport | null;
  loading: boolean;
  users: PublicUser[];
  me: { id: string; username: string };
  onSay: (notice: Notice) => void;
  onReport: (next: OpsReport) => void;
  /** 改完账号后重读列表 / 审计 / 额度（这些动作都留痕）。 */
  onChanged: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  /** 复制提示的复位计时器：连点两次时，前一个 timer 不能把后一次的提示提前收掉。 */
  const resetTimer = useRef<number | null>(null);

  const [pwdFor, setPwdFor] = useState("");
  const [pwdValue, setPwdValue] = useState("");
  const [pwdMust, setPwdMust] = useState(true);
  const [pwdBusy, setPwdBusy] = useState(false);

  useEffect(() => {
    // 默认选第一个账号：进页面就能直接输密码，不用先点一下下拉。
    if (pwdFor) return;
    if (users.length > 0) setPwdFor(users[0].id);
  }, [users, pwdFor]);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, []);

  async function savePassword() {
    if (pwdBusy) return;
    const target = users.find((u) => u.id === pwdFor);
    if (!target) {
      onSay({ kind: "err", text: "先选一个账号。" });
      return;
    }
    const problem = passwordProblem(pwdValue, target.username);
    if (problem) {
      onSay({ kind: "err", text: problem });
      return;
    }
    setPwdBusy(true);
    const r = await api("/api/admin/users", {
      method: "PATCH",
      body: { id: target.id, newPassword: pwdValue, mustChangePassword: pwdMust },
    });
    setPwdBusy(false);
    if (!r.ok) {
      // 失败时不清空输入：管理员输了 20 位、服务端拒了，输入框一空他只会以为改成功了。
      onSay({ kind: "err", text: r.message });
      return;
    }
    setPwdValue("");
    onSay({
      kind: "ok",
      text:
        "已改 " + target.username + " 的密码" +
        (target.id === me.id ? "（你自己会被踢下线，请重新登录）" : "，他的所有设备已下线"),
    });
    await onChanged();
  }

  const envSnippet = report
    ? [
        "# 站点身份（备案号为空时生产环境页脚不显示号码）",
        "PROBE_SITE_URL=" + (report.site.url ?? ""),
        "PROBE_ICP_LICENSE=" + (report.site.icp ?? ""),
        "PROBE_POLICE_LICENSE=" + (report.site.police ?? ""),
        "PROBE_OPERATOR_NAME=" + (report.site.operator ?? ""),
        "PROBE_CONTACT_EMAIL=" + (report.site.contact ?? ""),
        "",
        "# 模型额度（进程级 / 按人）",
        "PROBE_DAILY_LLM_CALLS=" + report.quota.global.cap,
        "PROBE_DAILY_LLM_CALLS_PER_USER=" + report.quota.perUser.cap,
      ].join("\n")
    : "";

  async function copyEnv() {
    try {
      await navigator.clipboard.writeText(envSnippet);
    } catch {
      // 非安全上下文（http + 非 localhost）没有 clipboard API，退回手动选中。
      setCopied(false);
      return;
    }
    setCopied(true);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      resetTimer.current = null;
      setCopied(false);
    }, 1800);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className={cardClass}>
        <h3 className="text-xs font-semibold text-white">账号密码（可写）</h3>
        <p className="mt-1 max-w-[76ch] text-[11px] leading-relaxed text-neutral-500">
          改完这个账号的所有设备立刻下线；勾了「要求他下次登录时改掉」，他登录后会被先拽到修改密码页。
          动作会写进审计（quota / password 都留痕）。
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block min-w-[180px] flex-1">
            <span className={labelClass}>账号</span>
            <select
              className={inputClass}
              value={pwdFor}
              disabled={pwdBusy || users.length === 0}
              onChange={(e) => setPwdFor(e.target.value)}
            >
              <option value="">{users.length === 0 ? "还没有账号" : "选择账号"}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                  {u.role === "admin" ? " · 管理员" : ""}
                  {u.status === "disabled" ? " · 已停用" : ""}
                  {u.mustChangePassword ? " · 待改密码" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block w-56">
            <span className={labelClass}>新密码（至少 10 位）</span>
            <input
              className={inputClass}
              type="password"
              autoComplete="new-password"
              value={pwdValue}
              disabled={pwdBusy}
              onChange={(e) => setPwdValue(e.target.value)}
            />
          </label>
          <button
            type="button"
            className={btnPrimary}
            onClick={() => void savePassword()}
            disabled={pwdBusy || !pwdFor || users.length === 0}
          >
            {pwdBusy ? "保存中…" : "修改密码"}
          </button>
        </div>
        <label className="mt-3 flex items-center gap-2 font-mono text-[10px] text-neutral-500">
          <input type="checkbox" checked={pwdMust} onChange={(e) => setPwdMust(e.target.checked)} />
          要求他下次登录时改掉
        </label>
        {pwdFor && pwdFor === me.id ? (
          <p className="mt-2 font-mono text-[10px] text-amber-400/80">
            选的是你自己：保存后你会被踢下线，需要用新密码重新登录。
          </p>
        ) : null}
      </div>

      <div className={cardClass}>
        <h3 className="text-xs font-semibold text-white">额度上限（可写）</h3>
        {report ? (
          <div className="mt-1">
            <QuotaCaps report={report} onReport={onReport} onSay={onSay} />
          </div>
        ) : (
          <p className={emptyClass}>{loading ? "读取中…" : "没有读到额度数据（/api/admin/ops 未返回）。"}</p>
        )}
      </div>

      {report ? (
        <ReadOnly report={report} copied={copied} onCopy={() => void copyEnv()} />
      ) : (
        <div className={cardClass}>
          <p className={emptyClass}>{loading ? "读取中…" : "没有读到部署配置（/api/admin/ops 未返回）。"}</p>
        </div>
      )}
    </div>
  );
}

/** 只读的那一半：全是进程启动时读到的环境变量。 */
function ReadOnly({ report, copied, onCopy }: { report: OpsReport; copied: boolean; onCopy: () => void }) {
  const { site, model, region, retrieval, guards, quota, at } = report;
  return (
    <>
      <div className={cardClass}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-white">部署态配置（只读）</h2>
          <span className="font-mono text-[10px] text-neutral-600">
            快照 {new Date(at).toLocaleString("zh-CN", { hour12: false })}
          </span>
        </div>
        <p className="mt-1 max-w-[76ch] text-[11px] leading-relaxed text-neutral-500">
          这些值来自服务进程启动时读到的环境变量。要改：服务器上编辑
          <code className="mx-1 text-neutral-400">/opt/probe/probe.env</code>
          然后 <code className="text-neutral-400">systemctl restart probe-web</code>。
          做成只读是有意的 —— 能从浏览器改这些，等于拿到 admin 就能关掉鉴权、换掉模型端点。
        </p>
        <div className="mt-3">
          <button type="button" className={btnNeutral} onClick={onCopy}>
            {copied ? "已复制" : "复制为 .env 片段"}
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className={cardClass}>
          <h3 className="text-xs font-semibold text-white">站点身份</h3>
          <div className="mt-2">
            <Row label="站点地址" value={orMissing(site.url)} env="PROBE_SITE_URL" />
            <Row label="ICP 备案号" value={orMissing(site.icp)} env="PROBE_ICP_LICENSE" />
            <Row label="公安备案号" value={orMissing(site.police)} env="PROBE_POLICE_LICENSE" />
            <Row label="运营者" value={orMissing(site.operator)} env="PROBE_OPERATOR_NAME" />
            <Row label="联系邮箱" value={orMissing(site.contact)} env="PROBE_CONTACT_EMAIL" />
          </div>
          {site.icp || site.police ? null : (
            <p className="mt-2 font-mono text-[10px] text-amber-400/80">
              两个备案号都没配：页脚在生产环境不会渲染号码（开发环境会显示灰提示）。
            </p>
          )}
        </div>

        <div className={cardClass}>
          <h3 className="text-xs font-semibold text-white">模型</h3>
          <div className="mt-2">
            <Row label="模型 ID" value={model.id} env={model.explicit ? "已显式指定" : "默认值"} />
            <Row label="端点" value={model.host} env="OPENAI_BASE_URL" />
            <Row label="区域策略" value={MODEL_MODE_TEXT[model.mode] ?? model.mode} />
            <Row
              label="服务端 key"
              value={quota.keySource === "none" ? "未配置" : "已配置"}
              env="OPENAI_API_KEY"
            />
          </div>
          {quota.keySource === "none" ? (
            <p className="mt-2 font-mono text-[10px] text-amber-400/80">
              没有服务端 key：全站走本地模板（检索与面板照常，摘要与断言抽取不调模型）。
            </p>
          ) : null}
        </div>

        <div className={cardClass}>
          <h3 className="text-xs font-semibold text-white">区域分流</h3>
          <div className="mt-2">
            <Row label="本次判定" value={region.value === "cn" ? "境内" : "境外"} />
            <Row label="判定依据" value={REGION_SOURCE_TEXT[region.source] ?? region.source} />
            <Row label="兜底值" value={region.fallback === "cn" ? "境内" : "境外"} env="PROBE_DEFAULT_REGION" />
          </div>
          <p className="mt-2 max-w-[62ch] text-[10px] leading-relaxed text-neutral-500">
            境内只用境内模型与境内检索源，境外才放开 —— 兜底取「境内」是因为误判成境外的代价更大
            （数据出境），反过来只是少用几个源。
          </p>
        </div>

        <div className={cardClass}>
          <h3 className="text-xs font-semibold text-white">检索源</h3>
          <table className="mt-2 w-full border-collapse text-left text-[11px]">
            <thead>
              <tr className="border-b border-neutral-800 font-mono text-[10px] text-neutral-600">
                <th className="py-1.5 pr-2 font-normal">源</th>
                <th className="py-1.5 pr-2 font-normal">本区域</th>
                <th className="py-1.5 pr-2 font-normal">密钥</th>
                <th className="py-1.5 pr-2 font-normal">环境变量</th>
              </tr>
            </thead>
            <tbody>
              {retrieval.map((row) => (
                <tr key={row.name} className="border-b border-neutral-900 last:border-0">
                  <td className="py-1.5 pr-2 text-neutral-300">{row.label}</td>
                  <td className={"py-1.5 pr-2 font-mono " + (row.allowed ? "text-neutral-400" : "text-neutral-600")}>
                    {row.allowed ? "允许" : "已拦"}
                  </td>
                  <td className={"py-1.5 pr-2 font-mono " + (row.configured ? "text-neutral-400" : "text-red-400/80")}>
                    {row.configured ? "已配" : "缺"}
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-[10px] text-neutral-600">{row.env}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 font-mono text-[10px] text-neutral-500">
            「已拦」= 本区域策略不放行；「缺」= 没有密钥，调用时会记成 not_configured。
          </p>
        </div>
      </div>

      <div className={cardClass}>
        <h3 className="text-xs font-semibold text-white">安全</h3>
        <div className="mt-2">
          <Row
            label="鉴权模式"
            value={
              guards.authMode === "on"
                ? "on（正常校验会话）"
                : guards.authMode + "（不校验会话，所有接口按管理员执行）"
            }
            env="PROBE_AUTH_MODE"
          />
        </div>
        {guards.authMode !== "on" ? (
          <p className="mt-2 font-mono text-[10px] text-red-400">
            鉴权不是 on：任何能访问端口的人都是管理员。生产环境请设回 on。
          </p>
        ) : null}
      </div>
    </>
  );
}
