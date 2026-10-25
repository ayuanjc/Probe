"use client";

import type { OpsReport } from "@/lib/ops-report";
import QuotaCaps from "./QuotaCaps";
import { cardClass, emptyClass, labelClass, rowClass, tableHeadClass, thClass, type Notice } from "./shared";

/**
 * 额度设置。
 *
 * 这里能改的东西会影响**所有人**：全局日额度用完，全站降级成本地模板。
 * 所以三条硬约束：
 *   1. 只允许正整数，且服务端还要再夹一次（前端校验只是让人少等一个来回）；
 *   2. 「保存」是整体覆盖写 —— 只改一个字段时另一个会带上当前生效值，
 *      不带上等于把另一条覆盖悄悄清掉；
 *   3. 数值落盘（.data/ops/limits.json）而不是只改内存：服务器每 5 分钟自动部署重启，
 *      只改内存的话运维刚设的上限活不过一次部署。
 */
export default function QuotaTab({
  report,
  loading,
  onReport,
  onSay,
}: {
  report: OpsReport | null;
  loading: boolean;
  onReport: (next: OpsReport) => void;
  onSay: (next: Notice) => void;
}) {
  if (!report) {
    return (
      <div className={cardClass}>
        <p className={emptyClass}>{loading ? "读取中…" : "没有读到额度数据（/api/admin/ops 未返回）。"}</p>
      </div>
    );
  }

  const { global, perUser, users, unassigned, keySource, modelEnabled } = report.quota;
  const pct = Math.round(global.ratio * 100);

  return (
    <div className="flex flex-col gap-4">
      <div className={cardClass}>
        <h2 className="text-sm font-semibold text-white">今天的额度</h2>
        <p className="mt-1 max-w-[76ch] text-[11px] leading-relaxed text-neutral-500">
          两道闸口径不同：<strong className="text-neutral-400">全局按上游调用次数</strong>（那是真金白银），
          <strong className="text-neutral-400">每人按操作记点</strong> —— 提问 1 点、生成面板 1 点、文档核验 3 点。
          按调用记的话，一次核验内部的二三十次调用会让用户觉得「核验一次吃掉八次提问的额度」。
          两个数都只统计服务端 key：用户自带 key 花的是他自己的钱，不占这里。
          计数在进程内存里，服务重启后归零（上限本身落盘，不会丢）。
          额度用完不会报错，只是整条链路降级成本地模板 —— 界面上会显示「已用完」。
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded border border-neutral-800 bg-black p-3">
            <p className={labelClass}>全局 · 今天已用</p>
            <p className="font-mono text-xl tabular-nums text-white">
              {global.used}
              <span className="text-[11px] text-neutral-500"> / {global.cap}</span>
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-neutral-900">
              <div
                className={global.exhausted ? "h-full bg-red-500/70" : "h-full bg-blue-500/70"}
                style={{ width: pct + "%" }}
              />
            </div>
            <p className="mt-1.5 font-mono text-[10px] text-neutral-500">
              剩 {global.remaining} 次 · {global.from === "ui" ? "后台覆盖值" : "环境变量"}
              {global.exhausted ? " · 已达上限，模型调用已停" : ""}
            </p>
          </div>

          <div className="rounded border border-neutral-800 bg-black p-3">
            <p className={labelClass}>每人 · 每日上限（点）</p>
            <p className="font-mono text-xl tabular-nums text-white">{perUser.cap}</p>
            <p className="mt-2 font-mono text-[10px] text-neutral-500">
              {perUser.from === "ui" ? "后台覆盖值" : "环境变量 PROBE_DAILY_LLM_UNITS_PER_USER"}
            </p>
            <p className="mt-1 font-mono text-[10px] text-neutral-500">
              服务端 key：{keySource === "none" ? "未配置（全站走本地模板）" : "已配置"}
              {modelEnabled ? "" : " · 当前不可用"}
            </p>
          </div>
        </div>
      </div>

      <div className={cardClass}>
        <h3 className="text-xs font-semibold text-white">改上限</h3>
        <div className="mt-1">
          <QuotaCaps report={report} onReport={onReport} onSay={onSay} />
        </div>
      </div>

      <div className={cardClass}>
        <h3 className="text-xs font-semibold text-white">按账号看今天的用量</h3>
        <table className="mt-2 w-full border-collapse text-left text-[11px]">
          <thead className={tableHeadClass}>
            <tr>
              <th className={thClass}>账号</th>
              <th className={thClass}>今日额度（点）</th>
              <th className={thClass}>上游调用</th>
              <th className={thClass}>剩余</th>
              <th className={thClass + " w-[26%]"}>用量</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={rowClass}>
                <td className="py-2 pr-2 font-mono text-neutral-300">{u.username}</td>
                <td className="py-2 pr-2 font-mono tabular-nums text-neutral-300">{u.used}</td>
                {/* 上游调用数只做参照：它比点数大得多，是「这条链路上游打了几次」的实况。 */}
                <td className="py-2 pr-2 font-mono tabular-nums text-neutral-500">{u.calls}</td>
                <td
                  className={
                    "py-2 pr-2 font-mono tabular-nums " + (u.remaining === 0 ? "text-red-400" : "text-neutral-500")
                  }
                >
                  {u.remaining}
                </td>
                <td className="py-2 pr-2">
                  <div className="h-1.5 overflow-hidden rounded bg-neutral-900">
                    <div
                      className={u.ratio >= 1 ? "h-full bg-red-500/70" : "h-full bg-blue-500/60"}
                      style={{ width: Math.round(u.ratio * 100) + "%" }}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 ? (
              <tr>
                <td colSpan={5} className={emptyClass}>
                  还没有账号。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {unassigned > 0 ? (
          <p className="mt-2 font-mono text-[10px] text-neutral-500">
            另有 {unassigned} 点没有绑定账号（定时任务 / 内部自检），没有并进任何人的账。
          </p>
        ) : null}
      </div>
    </div>
  );
}
