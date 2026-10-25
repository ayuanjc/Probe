/**
 * 运营者联系信息的**唯一来源**。
 *
 * 之前这三个地方各读一次 process.env：用户协议的行内渲染（inline.tsx）、隐私政策页、
 * 页脚。同一个邮箱写三遍的后果不是「不一致」那么温和 —— 是协议里写了 A 邮箱、
 * 隐私政策写了 B、页脚空着，而 GDPR/PIPL 的通告与响应义务恰恰要求这三处指向同一个
 * 可用的联系方式。所以这里集中定义，env 仍然可以覆盖（部署方换人不用改代码）。
 *
 * 服务端读取（模块在服务端被 import），不进浏览器 bundle。
 */

/** 默认联系邮箱；PROBE_CONTACT_EMAIL 可覆盖。 */
export const DEFAULT_CONTACT_EMAIL = "ayuanjc@stu.zcst.edu.cn";

/** env 显式设成空串或纯空格时回落到默认值，避免页面上出现「未配置」这种半成品文案。 */
export const CONTACT_EMAIL =
  (process.env.PROBE_CONTACT_EMAIL ?? "").trim() || DEFAULT_CONTACT_EMAIL;

/** 运营者署名；留空则由调用方决定如何显示（页脚回落为「探针 · Probe」）。 */
export const OPERATOR_NAME = (process.env.PROBE_OPERATOR_NAME ?? "").trim();
