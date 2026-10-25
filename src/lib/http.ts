/**
 * 直连 GET —— 刻意不走系统代理。
 *
 * 为什么要自己发请求：本机开着 `NODE_USE_ENV_PROXY=1` 时，Node 的 fetch 会走
 * 环境变量里的 HTTPS_PROXY，而那条链路对 api.mymemory.translated.net 这类站点会
 * ECONNRESET（实测 6/6 失败，同一个 URL 直连 100% 成功；curl 走代理也正常，
 * 说明是 Node 侧代理链路的问题，不是目标站点的问题）。
 *
 * node:https 默认不读代理环境变量，正好用来兜住这条链路。
 * 代价是这里发出去的请求不会走代理 —— 所以只用于我们自己选定的翻译/抓取目标。
 *
 * 这个文件同时是「服务端能去访问哪里」的唯一闸门：调用方不再自己判域名。
 * 原因写在下面 hostAllowed() 的注释里 —— 域名启发式守不住，必须按解析出的 IP 判。
 */

import { lookup } from "node:dns/promises";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { isIP, type LookupFunction } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type DirectReply =
  | { ok: true; status: number; contentType: string; body: string; truncated: boolean }
  | { ok: false; reason: string };

type Options = {
  timeoutMs?: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
  maxBytes?: number;
  /**
   * 整条重定向链的绝对截止时刻（epoch ms）。
   *
   * 不给它的时候，每跟一跳都会重开一个 timeoutMs 计时器：默认 8s × 最多 4 跳
   * = 单次抓取能挂到 32s，而调用方按「8s 抓一次」估的超时全被打穿。
   * 由入口算一次，后续每一跳只拿剩余预算。
   */
  deadline?: number;
};

const DEFAULT_UA = "Mozilla/5.0 (compatible; probe/0.1; +https://localhost)";

/* --------------------------- 主机白名单 --------------------------- */

/**
 * 私网 / 回环 / 云元数据地址。IPv4 用前缀表算，IPv6 按前 16 位与特殊段判。
 */
const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n * 256) + v;
  }
  return n;
}

function v4Private(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return true;
  for (const [base, bits] of PRIVATE_V4) {
    const b = v4ToInt(base);
    if (b === null) continue;
    const mask = bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0;
    if (((n & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

/** 已解析出来的地址能不能访问。判的是地址，不是域名。 */
export function isPrivateAddress(ip: string): boolean {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (raw.length === 0) return true;

  const kind = isIP(raw);
  if (kind === 4) return v4Private(raw);
  if (kind !== 6) return true;

  // IPv4-mapped / IPv4-compatible：::ffff:127.0.0.1 与 ::ffff:7f00:1 两种写法都要拦。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  if (mapped) return v4Private(mapped[1]);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(raw);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return v4Private([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join("."));
  }

  if (raw === "::" || raw === "::1") return true;
  if (/^fe[89ab]/.test(raw)) return true; // fe80::/10 链路本地
  if (/^f[cd]/.test(raw)) return true; // fc00::/7 唯一本地
  if (/^2001:0?db8/.test(raw)) return true; // 文档地址
  if (/^64:ff9b/.test(raw)) return true; // NAT64，转出去可能是任意内网
  if (/^ff/.test(raw)) return true; // 组播
  return false;
}

const HOST_TTL_MS = 5 * 60_000;

type HostVerdict =
  | { ok: true; address: string; family: number }
  | { ok: false; reason: string };

const hostCache = new Map<string, { v: HostVerdict; at: number }>();
/** 缓存上限。DNS 校验结果是小对象，但无界 Map 就是内存泄漏的另一种写法。 */
const HOST_CACHE_MAX = 512;

/**
 * 允许访问的端口（默认只有 80 / 443）。
 *
 * 不限制端口，这个抓取器就等价于「任意内网/全网端口探针」：
 * `https://target:22`、`:6379`、`:9200` 都能被当成"文章地址"打一发，
 * 从响应时间和报错就能判断端口开着没有。需要别的端口用
 * PROBE_FETCH_ALLOWED_PORTS 显式打开。
 */
const ALLOWED_PORTS = (() => {
  const raw = process.env.PROBE_FETCH_ALLOWED_PORTS;
  const list = (raw && raw.trim() ? raw : "80,443")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65_536);
  return new Set<number>(list.length > 0 ? list : [80, 443]);
})();

export function portAllowed(port: number): boolean {
  return ALLOWED_PORTS.has(port);
}

/**
 * 这个主机名能不能访问。**每一次请求、每一跳重定向都要过这一关。**
 *
 * 早期版本只在 translate.ts 里按域名做启发式（localhost / 127. / 192.168. …），
 * 两个问题让它形同虚设：
 *   1. 只校验用户提交的那一跳，3xx 之后的 Location 不再复查 ——
 *      `http://evil/` 302 到 `http://169.254.169.254/latest/meta-data/` 就进去了；
 *   2. 域名长得不像内网不代表解析结果不是内网：`127.0.0.1.nip.io`、`localhost.`、
 *      `[::ffff:127.0.0.1]` 全都不在启发式名单里，但都指向本机。
 * 所以改成「先解析，再判地址」：域名注册成什么无所谓，解析出私网 IP 一律拒绝。
 */
export async function hostAllowed(hostname: string): Promise<boolean> {
  return (await resolveAllowed(hostname)).ok;
}

/**
 * 解析主机名，并返回「已经判过、可以直接连」的那个地址。
 *
 * 为什么要把地址带出来：旧写法是 hostAllowed() 判一次、node:http 内部再解析
 * 一次。两次 DNS 之间攻击者可以把域名换绑到 127.0.0.1 —— 校验通过、
 * 连接却落到内网（DNS rebinding 的 TOCTOU）。现在把校验时拿到的地址通过
 * `lookup` 选项钉给底层 socket，只连判过的地址，不再有第二次解析。
 */
async function resolveAllowed(hostname: string): Promise<HostVerdict> {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host.length === 0) return { ok: false, reason: "host_blocked" };

  const hit = hostCache.get(host);
  if (hit && Date.now() - hit.at < HOST_TTL_MS) return hit.v;

  let verdict: HostVerdict;
  const literal = isIP(host);
  if (literal !== 0) {
    verdict = isPrivateAddress(host)
      ? { ok: false, reason: "host_blocked" }
      : { ok: true, address: host, family: literal };
  } else {
    try {
      const addrs = await lookup(host, { all: true, verbatim: true });
      const good = addrs.filter((a) => !isPrivateAddress(a.address));
      // 只要有一条解析结果落在内网就整域名拒绝：多 A 记录轮询也绕不过去。
      verdict =
        good.length > 0 && good.length === addrs.length
          ? { ok: true, address: good[0].address, family: good[0].family }
          : { ok: false, reason: "host_blocked" };
    } catch {
      // 解析不出来就别发请求：能连上的可能性不比解析失败更高。
      verdict = { ok: false, reason: "host_blocked" };
    }
  }

  hostCache.set(host, { v: verdict, at: Date.now() });
  /*
   * 先清过期条目，**再**按插入序砍到上限以内。
   *
   * 只清过期那条太乐观：5 分钟里被解析过 512 个不同域名（一堆短链接重定向
   * 就够）时，条条都还新鲜，于是一条都删不掉，Map 只增不减。清完过期之后
   * 若仍超限，就从最老的开始砍 —— Map 的迭代序是插入序，等价于一个粗 LRU。
   */
  if (hostCache.size > HOST_CACHE_MAX) {
    const now = Date.now();
    for (const [k, entry] of hostCache) if (now - entry.at >= HOST_TTL_MS) hostCache.delete(k);
    for (const k of hostCache.keys()) {
      if (hostCache.size <= HOST_CACHE_MAX) break;
      hostCache.delete(k);
    }
  }
  return verdict;
}

/** 把已校验的地址钉给 socket，杜绝「校验的 IP ≠ 连接的 IP」。 */
function pinnedLookup(address: string, family: number): LookupFunction {
  const pin = (
    _host: string,
    options: { all?: boolean } | number | undefined,
    callback: (...args: unknown[]) => void,
  ): void => {
    if (typeof options === "object" && options !== null && options.all === true) {
      (callback as unknown as (e: null, list: { address: string; family: number }[]) => void)(null, [
        { address, family },
      ]);
      return;
    }
    (callback as unknown as (e: null, a: string, f: number) => void)(null, address, family);
  };
  return pin as unknown as LookupFunction;
}

const MAX_DECODED_BYTES = 4_000_000;

/**
 * 按 charset 解码正文，并兜住「说了 identity 却还是压缩」的情况。
 *
 * 一律 utf8 的后果不是"偶尔出现方块"，而是 GBK/Big5 站点整篇乱码：
 * 下游按句子切段、按数字比对专名，全都在乱码上做 —— 那比直接失败更糟。
 */
function decodeBody(buf: Buffer, contentType: string, contentEncoding: string): string {
  let raw = buf;
  const enc = contentEncoding.toLowerCase().trim();
  try {
    if (enc === "gzip" || enc === "x-gzip") raw = gunzipSync(buf, { maxOutputLength: MAX_DECODED_BYTES });
    else if (enc === "deflate") raw = inflateSync(buf, { maxOutputLength: MAX_DECODED_BYTES });
    else if (enc === "br") raw = brotliDecompressSync(buf, { maxOutputLength: MAX_DECODED_BYTES });
  } catch (err) {
    /**
     * 解不开就按原样继续：宁可乱码，也不要在这里把整次抓取判失败。
     *
     * 但压缩炸弹必须单独处理：2MB 的 gzip 可以解出 GB 级内容，
     * 无上限的 gunzipSync 一次就能把进程内存吃光（我们声明了
     * accept-encoding: identity，但站点不受这个声明约束）。
     * 加了 maxOutputLength 之后超限会抛 ERR_BUFFER_TOO_LARGE，
     * 这种情况返回空正文（下游按"太短/不是 HTML"处理），
     * 而不是把压缩流当正文继续往下跑。
     */
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
    if (code === "ERR_BUFFER_TOO_LARGE" || code === "ERR_OUT_OF_RANGE") return "";
    raw = buf;
  }
  /*
   * 这里曾经是 /charset="?([w-]+)/i —— 少了一个反斜杠，字符类变成字面量
   * 「w」和「-」，于是 gbk/gb2312/big5 的页面一条都匹配不上，windows-1252
   * 只会捕到 "w"，全都回落到 utf-8：中文整篇变乱码，而界面只会说「正文太短」。
   * 另把 . 和 : 补进字符类（x-user-defined 这类带点的 name 也有）。
   */
  const m = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType);
  const charset = (m?.[1] ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(charset, { fatal: false }).decode(raw);
  } catch {
    return raw.toString("utf8");
  }
}

export async function getDirect(url: string, opts: Options = {}): Promise<DirectReply> {
  const { timeoutMs = 8000, headers = {}, maxRedirects = 3, maxBytes = 2_000_000 } = opts;
  // 整条链共用一份预算：入口定 deadline，重定向每跳只拿剩余。
  const deadline = opts.deadline ?? Date.now() + timeoutMs;
  const budgetMs = Math.max(1, Math.min(timeoutMs, deadline - Date.now()));

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "url_invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "url_invalid" };
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!portAllowed(port)) {
    return { ok: false, reason: "port_blocked" };
  }
  const verdict = await resolveAllowed(parsed.hostname);
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason };
  }

  return new Promise<DirectReply>((resolve) => {
    let timedOut = false;
    const send = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      parsed,
      {
        method: "GET",
        // 只连校验过的那个地址（防 DNS rebinding 的第二跳解析）
        lookup: pinnedLookup(verdict.address, verdict.family),
        headers: {
          "user-agent": DEFAULT_UA,
          /**
           * 只要明文。默认不声明时多数站点会给 identity，但也有站点照样压 gzip，
           * 于是我们拿到的是一坨二进制再按 utf8 解码 —— 正文直接变乱码。
           * 明确要 identity，拿到什么就是什么。
           */
          "accept-encoding": "identity",
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;

        // 重定向要自己跟：node:https 不做。
        if (status >= 300 && status < 400 && location && maxRedirects > 0) {
          res.resume();
          let next: URL;
          try {
            next = new URL(location, parsed);
          } catch {
            // Location 写成 `//`、IPv6 括号残缺时 new URL 会抛同步异常。
            // 这个回调里抛出去没人接：Promise 不 settle，路由 500。
            resolve({ ok: false, reason: "invalid_redirect" });
            return;
          }
          if (next.protocol !== "http:" && next.protocol !== "https:") {
            resolve({ ok: false, reason: "url_invalid" });
            return;
          }
          // 下一跳由 getDirect 自己再验一次主机（hostAllowed 在函数入口）。
          // deadline 一路带下去，跳数再多也不放大总时长。
          void getDirect(next.toString(), {
            ...opts,
            timeoutMs,
            deadline,
            maxRedirects: maxRedirects - 1,
          }).then(resolve);
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            ok: true,
            status,
            contentType: String(res.headers["content-type"] ?? ""),
            body: decodeBody(
              Buffer.concat(chunks),
              String(res.headers["content-type"] ?? ""),
              String(res.headers["content-encoding"] ?? ""),
            ),
            truncated,
          });
        });
        res.on("error", () => {
          /**
           * 只有"被我们自己按字节上限掐断"才叫成功（truncated 已经标出来了）。
           * 其它情况是传输中断或超时：把半截正文当成功返回，会让下游把
           * 一篇残缺的文章当成完整文章去分段翻译 —— 那比直接失败更糟。
           */
          if (truncated) {
            resolve({
              ok: true,
              status,
              contentType: String(res.headers["content-type"] ?? ""),
              body: decodeBody(
              Buffer.concat(chunks),
              String(res.headers["content-type"] ?? ""),
              String(res.headers["content-encoding"] ?? ""),
            ),
              truncated: true,
            });
            return;
          }
          resolve({ ok: false, reason: timedOut ? "timeout" : "fetch_failed" });
        });
      },
    );

    req.setTimeout(budgetMs, () => {
      timedOut = true;
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ ok: false, reason: err.message === "timeout" ? "timeout" : "fetch_failed" });
    });
    req.end();
  });
}
