import Link from "next/link";

import { OPERATOR_NAME } from "@/lib/legal/contact";

/**
 * 全站页脚：备案信息位 + 合规入口。
 *
 * 为什么单独一个组件而不是塞进 Workspace 的页脚：Workspace 的页脚属于“产品页脚”
 * （版本号 / 反馈 / 指标），只在首页出现；备案号、隐私政策、用户协议是**每一页**都要有的
 * 法律信息 —— 登录页、账号页、指标页同样需要。所以它挂在 layout 上，跟产品页脚互不干扰。
 *
 * 三条自我约束：
 * 1. **没批下来的号一个都不挂**。假号比留空恶劣得多：那是向管局与访客提供虚假备案信息。
 *    生产环境未配置就整段不渲染；开发环境给一行灰提示，提醒部署时还要补什么。
 * 2. **号必须可点**回工信部查询页，这是《互联网信息服务管理办法》要求的展示形式：
 *    备案号 + 超链接。
 * 3. **AI 生成声明写在这里**，而不是只在结果页 —— 它在任何一页被看到都成立。
 *
 * 环境变量（都是服务端读，不进浏览器 bundle）：
 *   PROBE_ICP_LICENSE     粤ICP备12345678号-1
 *   PROBE_POLICE_LICENSE  粤公网安备 44030502008569号
 *   PROBE_OPERATOR_NAME   页脚署名（个人姓名或单位名称）
 *   PROBE_CONTACT_EMAIL   隐私政策/用户协议里写的联系邮箱
 */

const ICP = (process.env.PROBE_ICP_LICENSE ?? "").trim();
const POLICE = (process.env.PROBE_POLICE_LICENSE ?? "").trim();
const OPERATOR = OPERATOR_NAME;

/** 生产环境留空就不渲染；本地开发给一行提示，避免“以为已经配好了”。 */
const IS_DEV = process.env.NODE_ENV !== "production";

/** 公安备案号里的中文与空格在查询链接里要去掉，只留数字编号。 */
const POLICE_CODE = POLICE.replace(/[^0-9]/g, "");

export default function SiteFooter() {
  return (
    <footer className="print:hidden border-t border-neutral-800 px-5 py-4 sm:px-8">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-1.5 font-mono text-[10px] leading-relaxed text-neutral-600">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-neutral-500">{OPERATOR || "探针 · Probe"}</span>
          <Link href="/privacy" className="transition-colors hover:text-neutral-300">
            隐私政策
          </Link>
          <Link href="/terms" className="transition-colors hover:text-neutral-300">
            用户协议
          </Link>
          {/* 这两个是不需要登录就能看的页：放在页脚，陌生人与爬虫都能找到。 */}
          <Link href="/entities" className="transition-colors hover:text-neutral-300">
            实体追踪
          </Link>
          <Link href="/check" className="transition-colors hover:text-neutral-300">
            公开核验
          </Link>
          <a
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-neutral-300"
          >
            工信部备案查询
          </a>
        </div>

        {(ICP || POLICE || (IS_DEV && !ICP)) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums">
            {ICP ? (
              <a
                href="https://beian.miit.gov.cn/"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-neutral-300"
              >
                {ICP}
              </a>
            ) : (
              IS_DEV && (
                <span className="text-yellow-500/70">
                  备案号未配置（生产环境设置 PROBE_ICP_LICENSE 后显示）
                </span>
              )
            )}
            {POLICE && (
              <a
                href={`https://beian.mps.gov.cn/#/query/webSearch?code=${POLICE_CODE}`}
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-neutral-300"
              >
                {POLICE}
              </a>
            )}
          </div>
        )}

        <p className="text-neutral-700">
          本站摘要、数据面板与翻译由人工智能模型生成，可能存在错误或过时，仅供参考；
          数字与结论请以可点开的原始信源为准。本页内容不构成医疗、法律、投资或安全建议。
        </p>
      </div>
    </footer>
  );
}
