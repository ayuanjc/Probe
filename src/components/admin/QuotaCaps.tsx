"use client";

import { useEffect, useState } from "react";
import type { OpsReport } from "@/lib/ops-report";
import { api, btnNeutral, btnPrimary, inputClass, labelClass, type Notice } from "./shared";

/**
 * 额度编辑（全局 / 每人）。
 *
 * 抽成独立组件，是因为「额度设置」页和「设置」页都要能改它 —— 两处各写一份输入框，
 * 迟早会出现一边校验 1–1000000、另一边忘了上限的情况。服务端（POST /api/admin/ops）
 * 仍然是唯一裁判，这里的校验只负责让人少等一个来回。
 *
 * 三条约束（来自后端语义，别在前端放松）：
 *   1. 只接受正整数，且各自有上限；
 *   2. 「保存」是**整体覆盖写** —— 只改一个字段时另一个要带上当前生效值，
 *      否则等于把另一条悄悄清掉；
 *   3. 数值落盘（.data/ops/limits.json）而不是只改内存：服务器每 5 分钟自动部署重启，
 *      只改内存的话刚设的上限活不过一次部署。
 */
export default function QuotaCaps({
  report,
  onReport,
  onSay,
  hint = true,
}: {
  report: OpsReport | null;
  onReport: (next: OpsReport) => void;
  onSay: (notice: Notice) => void;
  /** 是否显示那两行说明（嵌在别处时可以关掉）。 */
  hint?: boolean;
}) {
  const [globalCap, setGlobalCap] = useState("");
  const [perUserCap, setPerUserCap] = useState("");
  const [busy, setBusy] = useState(false);
  /** 用户动过输入框就别再被刷新覆盖 —— 边看数字边被改写是最难受的一种交互。 */
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!report || dirty) return;
    setGlobalCap(String(report.quota.global.cap));
    setPerUserCap(String(report.quota.perUser.cap));
  }, [report, dirty]);

  async function save(next: { globalCap?: number | null; perUserCap?: number | null }, label: string) {
    if (busy) return;
    setBusy(true);
    // api() 自己会 stringify，这里传对象；传字符串会被再包一层引号。
    const r = await api<{ ok: boolean; report?: OpsReport }>("/api/admin/ops", { method: "POST", body: next });
    setBusy(false);
    if (!r.ok || !r.data?.report) {
      onSay({ kind: "err", text: r.message });
      return;
    }
    onReport(r.data.report);
    setDirty(false);
    onSay({ kind: "ok", text: label });
  }

  function submit() {
    const g = Number(globalCap.trim());
    const p = Number(perUserCap.trim());
    if (!Number.isInteger(g) || g < 1 || g > 1_000_000) {
      onSay({ kind: "err", text: "全局日额度要是 1–1000000 之间的整数。" });
      return;
    }
    if (!Number.isInteger(p) || p < 1 || p > 100_000) {
      onSay({ kind: "err", text: "每人日额度（点）要是 1–100000 之间的整数。" });
      return;
    }
    if (p > g) {
      onSay({ kind: "err", text: "每人额度不该大于全局额度 —— 那样没有人会真正被个人闸拦住。" });
      return;
    }
    void save({ globalCap: g, perUserCap: p }, "额度已保存，立即生效。");
  }

  return (
    <div>
      {hint ? (
        <p className="text-[11px] leading-relaxed text-neutral-500">
          全局按上游调用次数算（钱），每人按操作点数算（提问 1 / 面板 1 / 核验 3）。
          保存后立刻生效，并写入 <code className="text-neutral-400">.data/ops/limits.json</code>（优先于环境变量）。
          「清除覆盖」= 回到服务器 <code className="text-neutral-400">probe.env</code> 里的值。
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block w-32">
          <span className={labelClass}>全局日额度（次）</span>
          <input
            className={inputClass}
            inputMode="numeric"
            value={globalCap}
            disabled={busy}
            onChange={(e) => {
              setDirty(true);
              setGlobalCap(e.target.value);
            }}
          />
        </label>
        <label className="block w-32">
          <span className={labelClass}>每人日额度（点）</span>
          <input
            className={inputClass}
            inputMode="numeric"
            value={perUserCap}
            disabled={busy}
            onChange={(e) => {
              setDirty(true);
              setPerUserCap(e.target.value);
            }}
          />
        </label>
        <button type="button" className={btnPrimary} onClick={submit} disabled={busy}>
          {busy ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          className={btnNeutral}
          disabled={busy}
          onClick={() => void save({ globalCap: null, perUserCap: null }, "已清除覆盖，回落到环境变量。")}
        >
          清除覆盖
        </button>
      </div>
    </div>
  );
}
