/**
 * 上游客器名 → 人话。
 *
 * 为什么要有这一层：落库时 provider 存的是**上游 id**（hn / ithome / sspai / baidu / juejin），
 * 这是对的 —— 存中文就等于把展示文案写进数据，改文案要动历史数据。但界面上
 * 不能直接印 `ithome` 这种字样，那是数据库的字段泄漏到用户脸上。
 *
 * 所以规则是：库里存 id，渲染前一律过这里。没有映射的保持原样 ——
 * 宁可显示一个陌生 id，也不要把不认识的东西硬翻成某个中文名（那才是编）。
 */

const PROVIDER_LABELS: Record<string, string> = {
  // 检索源（src/lib/schemas.ts 的 ProviderName）
  bocha: "博查",
  tavily: "Tavily",
  gdelt: "GDELT",
  wiki: "维基百科",
  hn: "Hacker News",
  fixture: "离线样本",
  // 中文科技前沿（src/lib/cn-trending.ts 的 CnSourceId）
  ithome: "IT之家",
  sspai: "少数派",
  // 国内热议榜单（src/lib/hotlist.ts 的 provider）
  baidu: "百度热搜",
  juejin: "掘金",
};

/** 未知 id 原样返回（转小写查表，保持「不认识的不要编」）。 */
export function providerLabel(raw: string | null | undefined): string {
  if (!raw) return "";
  const key = raw.trim().toLowerCase();
  return PROVIDER_LABELS[key] ?? raw.trim();
}

/** 测试/文档用：已知的映射表（副本，改不到内部）。 */
export function knownProviders(): string[] {
  return Object.keys(PROVIDER_LABELS);
}
