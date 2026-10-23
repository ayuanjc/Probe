"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import { compile } from "@/lib/compile";
import { DEFAULT_KIND, KIND_ZH, MODULE_SIZE, compileErrorText } from "@/lib/module-catalog";
import type { DatasetMeta, ModulePlanReply } from "@/lib/module-plan";
import { ModuleSpecSchema, type Dataset } from "@/lib/schemas";
import type { ModuleState } from "@/hooks/useProbe";

/**
 * 「一句话生成面板」（PRD 2.5），放在工作台右侧的常驻侧栏里。
 *
 * 边界：这个框只决定"看哪份数据、用哪种图形"，不写 ECharts option。
 * 服务端回一个 ModuleSpec，客户端还要自己过一遍 compile() —— 真正的白名单在
 * 本地。服务端拒绝和本地拒绝都要说出来：静默不出现，用户会以为功能坏了。
 *
 * 竖排布局是给 340px 侧栏定的：横排的输入框+按钮在窄栏里会把 placeholder 挤成四个字。
 */

type Props = {
  /** 这一轮真实产出的数据集（带完整 rows，用于编译校验）。 */
  datasets: Dataset[];
  /** 已有卡片，用来保证新 id 不撞。 */
  modules: ModuleState[];
  confidence: number;
  sourceIds: string[];
  /** 设置面板里的 key，随请求带走（和 /api/search 同一套）。 */
  headers: Record<string, string>;
  onAdd: (m: ModuleState) => void;
  /** 生成成功后把视线带到新卡片上（浮层自己会先收起）。 */
  onReveal?: (id: string) => void;
};

function toMeta(ds: Dataset): DatasetMeta {
  return {
    id: ds.id,
    name: ds.name,
    unit: ds.unit,
    fields: ds.fields,
    sample: ds.rows.slice(0, 3),
  };
}

export default function ModulePrompt({
  datasets,
  modules,
  confidence,
  sourceIds,
  headers,
  onAdd,
  onReveal,
}: Props) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<{
    id: string;
    title: string;
    engine: string;
    reason: string;
  } | null>(null);
  const seq = useRef(0);

  const taken = useMemo(() => new Set(modules.map((m) => m.id)), [modules]);

  function nextId(): string {
    let id = "";
    do {
      seq.current += 1;
      id = "m-custom-" + seq.current;
    } while (taken.has(id));
    return id;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ask = instruction.trim();
    if (!ask || busy) return;

    setBusy(true);
    setError(null);
    setOk(null);

    try {
      const res = await fetch("/api/module", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ instruction: ask, datasets: datasets.map(toMeta) }),
      });
      const data = (await res.json().catch(() => null)) as ModulePlanReply | null;
      if (!data) {
        setError("接口没有返回可读结果（" + res.status + "）。");
        return;
      }
      if (!data.ok) {
        setError(data.message);
        return;
      }

      const id = nextId();
      const parsed = ModuleSpecSchema.safeParse({ ...data.spec, id });
      if (!parsed.success) {
        // 服务端给的 spec 不合 schema 属于契约破损，必须暴露而不是吞掉。
        setError("返回的面板定义不合法：" + (parsed.error.issues[0]?.message ?? "schema_invalid"));
        return;
      }

      const spec = parsed.data;
      const ds = datasets.find((d) => d.id === spec.dataset);
      if (!ds) {
        setError("这份面板引用了不存在的数据集：" + spec.dataset + "。");
        return;
      }

      // 服务端只有样例行，判断不了"边太少/时间倒序"这类结构约束，所以真正的
      // 编译必须在这里用完整数据跑一遍。拒绝就拒绝，不降级成表格糊过去。
      // table / kpi 不经过 ECharts 编译器（它们不产 option），天然可渲染。
      if (spec.kind !== "table" && spec.kind !== "kpi") {
        const built = compile(spec, ds);
        if (!built.ok) {
          const detail = "detail" in built ? built.detail : undefined;
          setError("「" + spec.title + "」画不出来：" + compileErrorText(built.reason, detail) + "。");
          return;
        }
      }

      const size = MODULE_SIZE[spec.kind];
      onAdd({
        id,
        kind: spec.kind,
        title: spec.title,
        w: size.w,
        h: size.h,
        status: "ready",
        spec,
        rows: ds.rows,
        fields: ds.fields,
        confidence,
        sourceIds,
        datasetName: ds.name,
      });
      setOk({ id, title: spec.title, engine: data.engine, reason: data.reason });
      setInstruction("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败");
    } finally {
      setBusy(false);
    }
  }

  const examples = datasets
    .map((d) => ({ id: d.id, name: d.name, kind: DEFAULT_KIND[d.id] }))
    .filter((d) => d.kind);

  return (
    <section className="panel p-4">
      <header className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-white">一句话生成面板</span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-neutral-600">
          {datasets.length} 份数据
        </span>
      </header>
      <p className="mt-1 font-mono text-[10px] leading-relaxed text-neutral-600">
        说清想看什么 → 生成 → 新面板插进结果网格
      </p>

      <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
        <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-[#0f0f0f] px-3 py-2 transition-colors focus-within:border-neutral-600">
          <span aria-hidden className="font-mono text-xs leading-none text-neutral-600">
            ＋
          </span>
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            maxLength={200}
            placeholder="用条形图看信源分布"
            aria-label="一句话生成面板"
            className="w-full min-w-0 bg-transparent font-mono text-xs text-neutral-200 outline-none placeholder:text-neutral-600"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !instruction.trim()}
          className="w-full cursor-pointer rounded-md border border-neutral-700 bg-neutral-800 py-2 font-mono text-[11px] text-white transition-colors hover:border-neutral-600 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:border-neutral-800 disabled:bg-[#0f0f0f] disabled:text-neutral-600" 
        >
          {busy ? "生成中…" : "生成"}
        </button>
      </form>

      {examples.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          <span className="font-mono text-[10px] text-neutral-600">试试</span>
          {examples.map((ex) => {
            const text = "用" + KIND_ZH[ex.kind] + "看" + ex.name;
            return (
              <button
                key={ex.id}
                type="button"
                title={text}
                onClick={() => setInstruction(text)}
                className="w-full cursor-pointer truncate rounded border border-neutral-800 px-2 py-1 text-left font-mono text-[10px] text-neutral-500 transition-colors hover:border-neutral-600 hover:text-neutral-300"
              >
                {text}
              </button>
            );
          })}
        </div>
      )}

      <p className="mt-3 font-mono text-[10px] leading-relaxed text-neutral-600">
        自定义面板跟着这一轮的数据走：刷新页面或换一个问题，它会一起消失。
      </p>

      {error && (
        <p className="mt-3 rounded border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-red-400">
          {error}
        </p>
      )}

      {ok && (
        <div className="mt-3 rounded border border-blue-500/25 bg-blue-500/[0.05] px-3 py-2">
          <p className="font-mono text-[10px] leading-relaxed text-blue-400">
            已加入网格：{ok.title} ·{" "}
            {ok.engine === "llm" ? "模型在已有数据集里挑的" : "本地关键词规则挑的"} · {ok.reason}
          </p>
          {onReveal && (
            <button
              type="button"
              onClick={() => onReveal(ok.id)}
              className="mt-2 cursor-pointer rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 font-mono text-[10px] text-white transition-colors hover:border-neutral-600 hover:bg-neutral-700"
            >
              去看看 →
            </button>
          )}
        </div>
      )}
    </section>
  );
}
