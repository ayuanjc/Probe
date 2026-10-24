/**
 * 应用版本：由 next.config.ts 从 package.json 读出来注入，
 * 所以唯一要改的地方是 package.json 的 version。
 *
 * 它跟 /api/version 里的 buildId 是两件事：buildId 标识「这一次构建」，
 * 每次自动更新都会变；version 标识「产品第几版」，只有人改 package.json 才变。
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_PROBE_VERSION ?? "0.0.0";

/** 展示用：V0.1.0。大小写固定，不跟着 package.json 里的写法漂。 */
export const VERSION_LABEL = "V" + APP_VERSION;