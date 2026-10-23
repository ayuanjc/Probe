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
 */

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

  return new Promise<DirectReply>((resolve) => {
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
          const next = new URL(location, parsed).toString();
          void getDirect(next, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve);
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
          // destroy 之后的 error 是正常收尾，已经攒到的字节仍然有用。
          resolve({
            ok: true,
            status,
            contentType: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ ok: false, reason: err.message === "timeout" ? "timeout" : "fetch_failed" });
    });
    req.end();
  });
}
