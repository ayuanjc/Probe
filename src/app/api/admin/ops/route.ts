import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage, readJsonBody } from "@/lib/request-guard";
import { authMode, requireAdmin } from "@/lib/auth/guard";
import { audit, listUsers, todayKey } from "@/lib/auth/store";
import {
  keySource,
  modelIsExplicit,
  prepareRuntimeConfig,
  regionSummary,
  resolvedBochaKey,
  resolvedModelId,
  resolvedTavilyKey,
  withRuntimeConfig,
} from "@/lib/runtime-config";
import {
  ALL_RETRIEVAL_PROVIDERS,
  retrievalAllowed,
  type RetrievalProvider,
} from "@/lib/region-policy";
import { defaultRegion, type Region } from "@/lib/region";
import {
  budgetExhausted,
  budgetUsed,
  llmEnabled,
  quotaLimits,
  scopeBudgetSnapshot,
  setQuotaLimits,
} from "@/lib/llm";
import { errorCounters, errorTotal, recentErrors } from "@/lib/error-log";
import { buildOpsReport, type RetrievalRow } from "@/lib/ops-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 后台「额度 / 设置」两页的唯一数据源。
 *
 * 只读一半（GET）与改额度（POST）都在这一个路由里：两页读的是同一份快照，
 * 分成两个端点会让「读完上一条、下一条已经变了」这种撕裂更容易发生。
 *
 * 三条纪律：
 *   1. 先拒跨站（响应里有模型端点、额度、数据目录这些部署指纹）；
 *   2. 只报"配没配"，绝不回显任何密钥本身 —— 面板是给运维看一眼的，不是备份渠道；
 *   3. 观测接口不该因为某一行数据奇怪就整体 500（buildOpsReport 里已经全部兜了默认值）。
 */
const perClient = createLimiter({
  name: "admin-ops",
  limit: readPositiveInt("PROBE_ADMIN_RATE_PER_MIN", 60),
});

const MAX_BODY_BYTES = 4_000;

/** 额度的合法区间：和 llm.ts 里的夹取保持一致，路由先给一句人话。 */
const GLOBAL_CAP_MAX = 1_000_000;
const PER_USER_CAP_MAX = 100_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function gate(request: Request): Response | null {
  const per = perClient.check(clientKey(request));
  if (per.ok) return null;
  return new Response(
    JSON.stringify({ ok: false, error: "rate_limited", message: "操作过于频繁，请稍后再试。" }),
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

function envOrNull(name: string): string | null {
  const v = (process.env[name] ?? "").trim();
  return v ? v : null;
}

const PROVIDER_LABEL: Record<RetrievalProvider, string> = {
  bocha: "博查",
  tavily: "Tavily",
  gdelt: "GDELT",
  wiki: "Wikipedia",
  hn: "Hacker News",
};

const PROVIDER_ENV: Record<RetrievalProvider, string> = {
  bocha: "BOCHA_API_KEY",
  tavily: "TAVILY_API_KEY",
  gdelt: "（无需密钥）",
  wiki: "（无需密钥）",
  hn: "（无需密钥）",
};

/** 五个检索源在本区域能不能用、key 配了没。 */
function retrievalRows(region: Region): RetrievalRow[] {
  return ALL_RETRIEVAL_PROVIDERS.map((name) => ({
    name,
    label: PROVIDER_LABEL[name],
    allowed: retrievalAllowed(region, name),
    configured: name === "bocha" ? Boolean(resolvedBochaKey()) : name === "tavily" ? Boolean(resolvedTavilyKey()) : true,
    env: PROVIDER_ENV[name],
  }));
}

async function snapshot(request: Request) {
  const cfg = await prepareRuntimeConfig(request);
  return withRuntimeConfig(cfg, async () => {
    const users = await listUsers();
    const limits = quotaLimits();
    const region = regionSummary();
    return buildOpsReport({
      now: Date.now(),
      day: todayKey(),
      quota: {
        globalCap: limits.globalCap,
        globalUsed: budgetUsed(),
        perUserCap: limits.perUserCap,
        globalFrom: limits.globalFrom,
        perUserFrom: limits.perUserFrom,
        exhausted: budgetExhausted(),
        // 问的是"服务端此刻有没有可用的模型 key"，与来访者自带的 key 无关：
        // 后台页面从不发送 x-probe-openai-key，所以 keySource() 在这里就是 env 视角。
        keySource: keySource(),
        modelEnabled: llmEnabled(),
      },
      users: users.map((u) => ({ id: u.id, username: u.username })),
      scopes: scopeBudgetSnapshot(),
      model: {
        id: resolvedModelId(),
        host: region.modelHost,
        mode: region.modelMode,
        explicit: modelIsExplicit(),
      },
      region: {
        value: region.region,
        source: region.source,
        fallback: defaultRegion(),
        retrieval: region.retrieval,
      },
      retrieval: retrievalRows(region.region),
      site: {
        url: envOrNull("PROBE_SITE_URL"),
        icp: envOrNull("PROBE_ICP_LICENSE"),
        police: envOrNull("PROBE_POLICE_LICENSE"),
        operator: envOrNull("PROBE_OPERATOR_NAME"),
        contact: envOrNull("PROBE_CONTACT_EMAIL"),
      },
      guards: { authMode: authMode() },
      // 错误账本是进程内存环：这里不做二次聚合，交给 buildOpsReport 夹形状。
      errors: { total: errorTotal(), byCode: errorCounters(), recent: recentErrors(40) },
    });
  });
}

export async function GET(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const limited = gate(request);
  if (limited) return limited;
  try {
    return json({ ok: true, report: await snapshot(request) });
  } catch (err) {
    return json({ ok: false, error: "ops_failed", message: publicMessage(err, "读取运维数据失败。") }, 500);
  }
}

/** null = 清掉覆盖、回落到 env；缺省字段保持原值不动。 */
function capField(
  raw: unknown,
  max: number,
): { ok: true; value: number | null | undefined } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: `额度必须是整数（收到 ${typeof raw === "string" ? raw.slice(0, 20) : typeof raw}）。` };
  }
  if (n < 1 || n > max) return { ok: false, message: `额度需在 1 到 ${max} 之间。` };
  return { ok: true, value: n };
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const limited = gate(request);
  if (limited) return limited;

  const parsed = await readJsonBody(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ ok: false, error: parsed.code, message: parsed.message }, parsed.status);
  const body = parsed.value as { globalCap?: unknown; perUserCap?: unknown } | null;
  if (!body || typeof body !== "object") {
    return json({ ok: false, error: "bad_body", message: "请求体必须是对象。" }, 400);
  }

  const g = capField(body.globalCap, GLOBAL_CAP_MAX);
  if (!g.ok) return json({ ok: false, error: "bad_global_cap", message: g.message }, 400);
  const p = capField(body.perUserCap, PER_USER_CAP_MAX);
  if (!p.ok) return json({ ok: false, error: "bad_per_user_cap", message: p.message }, 400);
  if (g.value === undefined && p.value === undefined) {
    return json({ ok: false, error: "nothing_to_change", message: "没有要改的字段（globalCap / perUserCap）。" }, 400);
  }

  // 缺省字段传当前生效值：setQuotaLimits 是整体覆盖写，不带上就把另一条覆盖抹掉了。
  const current = quotaLimits();
  try {
    setQuotaLimits({
      globalCap: g.value === undefined ? (current.globalFrom === "ui" ? current.globalCap : null) : g.value,
      perUserCap: p.value === undefined ? (current.perUserFrom === "ui" ? current.perUserCap : null) : p.value,
    });
  } catch (err) {
    return json({ ok: false, error: "write_failed", message: publicMessage(err, "额度写入失败，请检查数据目录权限。") }, 500);
  }

  await audit({
    actor: auth.user.username,
    action: "quota.update",
    target: "limits",
    detail: `global=${g.value === undefined ? "keep" : String(g.value)} perUser=${p.value === undefined ? "keep" : String(p.value)}`,
    ip: clientKey(request),
  }).catch(() => undefined);

  try {
    return json({ ok: true, report: await snapshot(request) });
  } catch (err) {
    return json({ ok: false, error: "ops_failed", message: publicMessage(err, "额度已写入，但重新读取失败。") }, 500);
  }
}
