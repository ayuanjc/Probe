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
import { isIP } from "node:net";
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
const hostCache = new Map<string, { ok: boolean; at: number }>();

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
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host.length === 0) return false;

  const hit = hostCache.get(host);
  if (hit && Date.now() - hit.at < HOST_TTL_MS) return hit.ok;

  let ok = true;
  if (isIP(host) !== 0) {
    ok = !isPrivateAddress(host);
  } else {
    try {
      const addrs = await lookup(host, { all: true, verbatim: true });
      if (addrs.length === 0) ok = false;
      else ok = addrs.every((a) => !isPrivateAddress(a.address));
    } catch {
      // 解析不出来就别发请求：能连上的可能性不比解析失败更高。
      ok = false;
    }
  }

  hostCache.set(host, { ok, at: Date.now() });
  if (hostCache.size > 512) {
    for (const [k, v] of hostCache) if (Date.now() - v.at >= HOST_TTL_MS) hostCache.delete(k);
  }
  return ok;
}

export async function getDirect(url: string, opts: Options = {}): Promise<DirectReply> {
  const { timeoutMs = 8000, headers = {}, maxRedirects = 3, maxBytes = 2_000_000 } = opts;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "url_invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "url_invalid" };
  }
  if (!(await hostAllowed(parsed.hostname))) {
    return { ok: false, reason: "host_blocked" };
  }

  return new Promise<DirectReply>((resolve) => {
    let timedOut = false;
    const send = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      parsed,
      {
        method: "GET",
        headers: { "user-agent": DEFAULT_UA, ...headers },
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
          void getDirect(next.toString(), { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve);
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
            body: Buffer.concat(chunks).toString("utf8"),
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
              body: Buffer.concat(chunks).toString("utf8"),
              truncated: true,
            });
            return;
          }
          resolve({ ok: false, reason: timedOut ? "timeout" : "fetch_failed" });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      timedOut = true;
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ ok: false, reason: err.message === "timeout" ? "timeout" : "fetch_failed" });
    });
    req.end();
  });
}
