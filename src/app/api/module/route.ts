import { z } from "zod";
import { ModuleKind, type Field, type ModuleSpec } from "@/lib/schemas";
import { generateStructured, llmEnabled, modelId } from "@/lib/llm";
import { prepareRuntimeConfig, withRuntimeConfig } from "@/lib/runtime-config";
import { createGate, createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage, readJsonBody } from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";
import { runWithCallScope } from "@/lib/call-scope";
import {
  describeDatasets,
  rulePlan,
  specFromPick,
  type DatasetMeta,
  type ModulePlanReply,
} from "@/lib/module-plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 「一句话生成模块」接口（PRD 2.5）。
 *
 * 它产出的是 ModuleSpec，不是 ECharts option：曲线的颜色、坐标轴、tooltip 全在
 * src/lib/compile.ts 里，这里只决定"看哪份数据、用哪种图形、叫什么名字"。
 *
 * 它和 /api/search 一样按 IP 限流，但更松（12/分钟）：用户看图时会连着试几次。
 */
const perClient = createLimiter({
  name: "module",
  limit: readPositiveInt("PROBE_MODULE_RATE_LIMIT_PER_MIN", 12),
});

/** 换 IP 就绕开 per-IP 额度，所以要一道进程级总闸。 */
const globalLimiter = createLimiter({
  name: "module-global",
  limit: readPositiveInt("PROBE_GLOBAL_MODULE_PER_MIN", 120),
});

/** 生成模块会打一次模型，并发卡死，超出直接 503。 */
const gate = createGate(readPositiveInt("PROBE_MODULE_CONCURRENCY", 3));

/** 请求体上限：16 个数据集 × (12 字段 + 3 行样本)，128KB 已经很宽松。 */
const MAX_BODY_BYTES = 128_000;

/**
 * 用户提交的行/字段名会被原样当对象键用，`__proto__` / `constructor` 这类键
 * 一旦写进普通对象，后续 `obj[k]` 读到的就是原型链上的东西（原型污染）。
 * 这些数据只用来给模型解释字段含义，丢掉这几个键不会有任何损失。
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const PickSchema = z.object({
  dataset: z.string().min(1),
  kind: ModuleKind,
  title: z.string().min(1).max(40),
  reason: z.string().max(160).optional(),
});

const SYSTEM =
  "你是情报终端的面板设计器。用户会给你一份「可用数据集」清单和一句自然语言要求。" +
  "你只能从清单里挑一份数据集、从固定图形集合里挑一种，并给它一个不超过 20 字的中文标题。" +
  "硬约束：不要编造清单里不存在的 dataset id 或字段名；不要说数据说明了什么；不要解释。" +
  "拿不出合适方案时，挑字段最贴合的一份并如实说明理由。";

function cleanField(v: unknown): Field | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { name?: unknown; type?: unknown; unit?: unknown };
  if (typeof o.name !== "string" || !o.name) return null;
  const type = o.type === "time" || o.type === "number" || o.type === "string" ? o.type : null;
  if (!type) return null;
  return { name: o.name.slice(0, 40), type, unit: typeof o.unit === "string" ? o.unit.slice(0, 16) : undefined };
}

function cleanRow(v: unknown): Record<string, string | number | null> | null {
  if (!v || typeof v !== "object") return null;
  const out: Record<string, string | number | null> = {};
  let n = 0;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (n++ >= 8) break;
    const key = k.slice(0, 40);
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === "string") out[key] = raw.slice(0, 120);
    else out[key] = null;
  }
  return out;
}

/**
 * 请求体来自浏览器，也可能来自任何会调用这个端口的人 —— 一律当不可信输入：
 * 字段数、样例行数、字符串长度全部收紧，超出的直接截断而不是报错，
 * 因为这些东西只用于让模型理解字段含义。
 */
function cleanDatasets(v: unknown): DatasetMeta[] {
  if (!Array.isArray(v)) return [];
  const out: DatasetMeta[] = [];
  for (const raw of v.slice(0, 16)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as { id?: unknown; name?: unknown; unit?: unknown; fields?: unknown; sample?: unknown };
    if (typeof o.id !== "string" || !o.id) continue;
    if (FORBIDDEN_KEYS.has(o.id)) continue;
    const fields = Array.isArray(o.fields)
      ? o.fields.map(cleanField).filter((f): f is Field => f !== null).slice(0, 12)
      : [];
    if (fields.length === 0) continue;
    const sample = Array.isArray(o.sample)
      ? o.sample.map(cleanRow).filter((r): r is Record<string, string | number | null> => r !== null).slice(0, 3)
      : [];
    out.push({
      id: o.id.slice(0, 64),
      name: typeof o.name === "string" ? o.name.slice(0, 80) : o.id.slice(0, 80),
      unit: typeof o.unit === "string" ? o.unit.slice(0, 16) : undefined,
      fields,
      sample,
    });
  }
  return out;
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;
  // 额度按人算：这一句「生成面板」的模型调用要记在这个账号头上，
  // 而不是记进所有人共用的那个进程级计数器。
  return runWithCallScope(
    { key: "u:" + auth.user.id, label: "用户 " + auth.user.username },
    () => generateFor(request),
  );
}

async function generateFor(request: Request): Promise<Response> {
  const per = perClient.check(clientKey(request));
  if (!per.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "rate_limited",
        message: `生成面板的请求过于频繁，请 ${per.retryAfterSeconds} 秒后重试。`,
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": String(per.retryAfterSeconds),
        },
      },
    );
  }
  const all = globalLimiter.check("all");
  if (!all.ok) {
    return json({ ok: false, error: "busy", message: "服务当前请求量过大，请稍后再试。" }, 503);
  }

  const limited = await readJsonBody(request, MAX_BODY_BYTES);
  if (!limited.ok) {
    return json({ ok: false, error: limited.code, message: limited.message }, limited.status);
  }
  const body = limited.value as { instruction?: unknown; datasets?: unknown } | null;
  if (!body || typeof body !== "object") {
    return json({ ok: false, error: "bad_request", message: "请求体不是合法 JSON。" }, 400);
  }

  const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 200) : "";
  if (!instruction) return json({ ok: false, error: "bad_request", message: "先写一句想看的图表。" }, 400);

  const datasets = cleanDatasets(body.datasets);
  if (datasets.length === 0) {
    return json(
      { ok: false, error: "no_dataset", message: "这一轮没有可用的数据集：先跑一次检索，面板出来之后再来加。" },
      422,
    );
  }

  const rule = rulePlan(instruction, datasets);

  // 有 key 才问模型；模型没给出可用方案就回到规则 —— 两条路都失败才把错误交给用户。
  const fallback = (why: string): ModulePlanReply => {
    if (rule.ok) return rule;
    return { ...rule, message: rule.message + "（" + why + "）" };
  };

  // 注意：key 的判断必须放进 withRuntimeConfig 里面。设置面板填的 key 是随请求头进来的，
  // 在外面读运行时配置等于读空 —— 之前就因为这个，用户自带 key 时这里永远走规则方案，
  // 面板填了 OpenAI key 却「没生效」，且没有任何提示。
  const cfg = await prepareRuntimeConfig(request);

  const prompt =
    "可用数据集：\n" +
    describeDatasets(datasets) +
    "\n\n用户要求：" +
    instruction +
    "\n\n可选图形（只能填这些值）：bar / line / pie / treemap / map / table / kpi / heatmap / radar / graph / funnel / gauge / scatter。";

  const release = gate.acquire();
  if (!release) return json(fallback("服务正忙，先走本地关键词规则"), 200);

  let pick: z.infer<typeof PickSchema> | null = null;
  /** 没拿到方案时说清是哪一种：没 key / 有 key 但上游没给。 */
  let why = "模型没有返回可用方案";
  try {
    pick = await withRuntimeConfig(cfg, async () => {
      if (!llmEnabled()) {
        why = "未配置模型 key，走本地关键词规则";
        return null;
      }
      return generateStructured({ schema: PickSchema, system: SYSTEM, prompt });
    });
  } catch (err) {
    /**
     * 这里原来把 publicMessage 的返回值丢掉了，why 还停在上面那句
     * 「模型没有返回可用方案」——于是 key 无效、429、超时统统显示成「模型没给方案」，
     * 用户没有任何线索去查自己的配置。publicMessage 已经做过脱敏（只回可读原因），
     * 拿它的返回当代替原因即可。
     */
    why = publicMessage(err, "面板生成失败");
  } finally {
    release();
  }

  if (!pick) return json(fallback(why));

  const planned = specFromPick(pick, datasets);
  if (!planned.ok) return json(fallback(planned.message));

  // 模型给的标题可能是空的英文串，兜一层：标题必须有可读的中文名。
  const spec: ModuleSpec = {
    ...planned.spec,
    title: planned.spec.title.trim() || planned.reason,
  };
  // 回显的模型名也要取请求里的那个：modelId() 读的是运行时配置，
  // 在 withRuntimeConfig 外面直接调，拿到的是 env / 默认值 —— 面板填了 deepseek-flash
  // 却回显 gpt-6-luna，用户会以为设置没生效。
  return json({ ...planned, spec, model: cfg.model || modelId() });
}
