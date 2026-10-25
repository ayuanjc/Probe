"use client";

import { useEffect, useState } from "react";
import { appPath } from "@/lib/base-path";
import { joinZh, modelVendor, retrievalLabel } from "@/lib/service-labels";

/**
 * 首页「试试」下面那两行：这一台机器的来访地址、属地，以及这一轮会用到谁。
 *
 * 为什么要把 IP 显示出来：访问者有权知道"服务端看到的我是谁"。
 * 很多产品只在隐私政策里含糊提一句，用户无从核对；把值打在页面上，
 * 用户立刻能判断"它认错了"还是"我被代理了"。
 *
 * 三件事必须诚实：
 *   1. 取不到就写取不到（直连部署、没经过代理时确实拿不到），不编造地址；
 *   2. 内网地址写内网（本地开发看到的就是 127.0.0.1，那不是"你的公网 IP"）；
 *   3. 属地没判定出来时说"没判定"，而不是从区域反推一个国家名字扣上去。
 *
 * 这个请求只问规则、不带 key、结果不缓存（服务端 no-store），
 * 也不落库 —— 页面上看到的地址出不了这一次请求。
 */

type RegionInfo = {
  region: "cn" | "intl";
  source: "mode" | "header" | "ip" | "default" | "unknown";
  country?: string;
  countryName?: string;
  ip?: string;
  ipScope: "public" | "private" | "unknown";
  modelHost: string;
  modelMode: "allowed" | "switched" | "blocked";
  retrieval: readonly string[];
};

/** 判定依据说人话 —— 与设置面板同一套措辞。 */
const SOURCE_TEXT: Record<RegionInfo["source"], string> = {
  mode: "部署时固定",
  header: "网关头国家码",
  ip: "来访 IP 反查",
  default: "属地未定位 · 按境内处理",
  unknown: "未知",
};

export default function VisitorRegion() {
  const [info, setInfo] = useState<RegionInfo | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(appPath("/api/region"), { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<RegionInfo>) : null))
      .then((data) => {
        if (alive && data) setInfo(data);
      })
      .catch(() => {
        // 拿不到就整块不渲染：宁可空着，也不在"服务将用到谁"这件事上瞎写。
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!info) return null;

  // 属地：有国家码就用中文名 + 码；没有就只说区域结论，并把"这是判出来的"留在下一行说明里。
  const area = info.countryName
    ? info.country
      ? info.countryName + "（" + info.country + "）"
      : info.countryName
    : info.region === "cn"
      ? "中国大陆"
      : "境外";

  // 地址一栏：只有真正拿到公网地址才显示值，其余照实描述。
  const ipText =
    info.ipScope === "public" && info.ip
      ? info.ip
      : info.ipScope === "private"
        ? "本机 / 内网地址"
        : "未取到（直连，未经代理）";

  const modelPart =
    info.modelMode === "blocked"
      ? "本地样本（当前区域没有可用模型）"
      : modelVendor(info.modelHost) + " 模型";
  // 五六个源全列出来会把这一行撑成一句废话；只报前三个，剩下的报数量。
  const names = info.retrieval.map(retrievalLabel);
  const sourcePart = names.length
    ? names.slice(0, 3).join("、") +
      (names.length > 3 ? " 等 " + names.length + " 个" : "") +
      "检索"
    : "本地演示样本";

  return (
    <div className="mt-5 flex flex-col items-end gap-1.5 text-right">
      <div
        className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 font-mono text-[10px] text-neutral-600"
        title="这是本站从这次请求里读到的来源信息：地址按可信代理跳数取，属地来自网关头或 IP 反查。只回显给你本人，不记录。"
      >
        <span>IP</span>
        <span className="text-neutral-400">{ipText}</span>
        <span className="text-neutral-800">·</span>
        <span className="text-neutral-400">{area}</span>
        <span className="text-neutral-800">·</span>
        <span>{SOURCE_TEXT[info.source] ?? "未知"}</span>
      </div>
      <p className="max-w-[560px] text-[10px] leading-relaxed text-neutral-600">
        您当前在<span className="text-neutral-400">{area}</span>，服务将会使用（
        <span className="text-neutral-400">
          {modelPart} · {sourcePart}
        </span>
        ），请遵守当地法律法规。
      </p>
    </div>
  );
}
