import type { Metadata } from "next";
import { CONTACT_EMAIL } from "@/lib/legal/contact";
import { LegalShell, LegalSection, LegalList } from "@/components/LegalDoc";

/**
 * 这两页必须每次现算：备案号与联系邮箱来自部署时的环境变量。
 * 静态预渲染会在 `next build` 那一刻把它们烤死，运维改完 .env.local 重启后
 * 页面还是旧号 —— 这种「改了没生效」在合规检查里最致命。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "隐私政策",
  description: "探针收集哪些数据、发给谁、留多久，以及你如何删除它们。",
};

/**
 * 隐私政策。
 *
 * 写的不是模板，是这份代码真实做过的事 —— 每一条都能在源码里指出位置：
 *   - 密码 scrypt + 每用户独立 salt，见 src/lib/auth/crypto.ts
 *   - 会话 cookie probe_session（HttpOnly / SameSite=Lax），见 src/lib/auth/session.ts
 *   - 登录 IP 只留 SHA-256 哈希，见 src/lib/auth/crypto.ts 的 hashAddress
 *   - 审计只保留最近 2000 条，见 src/lib/auth/store.ts 的 AUDIT_CAP
 *   - 反馈明文落盘 .cache/feedback.jsonl，见 src/app/api/feedback/route.ts
 *   - 查询会打到模型服务与 Tavily / GDELT / Wikipedia / HN，见 src/lib/llm.ts 与检索层
 *
 * 之所以要这么较真：备案与网信核查都会拿隐私政策和实际数据流对表，
 * 一句“我们重视您的隐私”对不上任何代码，等于没写。
 */

const UPDATED = "2026-10-25";
const CONTACT = CONTACT_EMAIL;

export default function PrivacyPage() {
  return (
    <LegalShell
      title="隐私政策"
      updated={UPDATED}
      intro={
        <p>
          探针是一个邀请制的检索与核验工具：你问一句话，它把散在各处的公开数据收回一张面板，
          并让每个数字都能点回原文。这份政策说明在这个过程中，哪些数据会离开你的浏览器、
          到哪里去、留多久，以及你怎样让它们消失。
        </p>
      }
    >
      <LegalSection heading="一、谁在处理你的数据">
        <p>
          本站由个人开发者运营与维护，服务器位于中华人民共和国境内（腾讯云）。
          与个人信息有关的请求、更正与删除，都可以直接发到
          {CONTACT ? (
            <a className="text-blue-500 hover:underline" href={`mailto:${CONTACT}`}>
              {CONTACT}
            </a>
          ) : (
            <span className="text-neutral-500">运营者邮箱（部署方需配置 PROBE_CONTACT_EMAIL）</span>
          )}
          。
        </p>
      </LegalSection>

      <LegalSection heading="二、我们收集什么">
        <LegalList
          items={[
            <>
              <span className="text-neutral-300">注册信息</span>：邀请码、用户名、密码。邀请码与会话令牌
              只保存 SHA-256 哈希；密码用 scrypt（N=16384, r=8, p=1）加每用户独立随机盐单向哈希，
              服务端不存在任何可以还原成明文密码的数据。
            </>,
            <>
              <span className="text-neutral-300">登录状态</span>：一枚名为 <code>probe_session</code> 的会话
              Cookie，HttpOnly、SameSite=Lax，经 HTTPS 访问时附加 Secure；有效期默认 7 天，
              可随时在「账号」页踢掉其它设备。
            </>,
            <>
              <span className="text-neutral-300">安全日志</span>：登录与敏感操作会记录 IP 的 SHA-256 哈希
              （不是明文地址）与 User-Agent，用于识别异常登录和展示你的登录设备列表。
            </>,
            <>
              <span className="text-neutral-300">协议确认记录</span>：你点击「同意并继续」时的
              协议版本号、确认时间、停留时长与网络地址的哈希指纹，保存在服务端本地文件中，
              用途只有一个 —— 在发生争议时证明你确实被给予了阅读并确认条款的机会。
              该记录同样只含指纹，不含明文地址。
            </>,
            <>
              <span className="text-neutral-300">检索内容</span>：你输入的查询词，以及据此生成的摘要、
              数据面板与翻译结果。为了降低重复开销，这些内容会在服务端内存中短期缓存，
              缓存时长由部署方的 <code>PROBE_CACHE_TTL_SECONDS</code> 决定。
            </>,
            <>
              <span className="text-neutral-300">你主动提交的反馈</span>：反馈文本与当时的查询词，
              以明文 JSONL 形式保存在服务器本地文件中，供运营者复现问题。
            </>,
            <>
              <span className="text-neutral-300">账号级历史</span>：为了让「我上次问的是什么」能在别的设备上也找回来，
              服务器会为每次提问保存一份索引 —— 见第四节，那里逐项列清存了什么、没存什么。
            </>,
            <>
              <span className="text-neutral-300">我们不收集</span>：通讯录、短信、精确地理位置、
              设备唯一标识、剪贴板。站内没有第三方统计脚本、没有广告 SDK、没有社交插件。
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection heading="三、数据会发给谁（按访问区域分流）">
        <p>
          一次检索会把你的<strong className="font-normal text-neutral-300">查询词</strong>
          作为请求内容发给第三方服务。发给谁，取决于这次访问被判定属于哪个区域 ——
          这是我们为控制数据出境做的分流，规则如下。
        </p>
        <LegalList
          items={[
            <>
              <span className="text-neutral-300">区域怎么判定</span>：依据访问来源的网络位置
              （CDN 边缘节点给出的国家码，或服务器看到的来访 IP 归属），以及运营方在部署时的显式配置。
              判定结果只在这一次请求内使用，不写入 Cookie、不写入账号资料、不与你的人身份关联。
            </>,
            <>
              <span className="text-neutral-300">判定为境内时</span>：模型只调用在中华人民共和国境内运营、
              且已按《生成式人工智能服务管理暂行办法》完成备案的模型服务（当前为深度求索 DeepSeek，
              <code>api.deepseek.com</code>）；检索只调用境内检索服务（博查，
              <code>api.bochaai.com</code>）。此时<strong className="font-normal text-neutral-300">不会</strong>
              向境外服务商发起请求。
            </>,
            <>
              <span className="text-neutral-300">判定为境外时</span>：可使用境外模型服务
              （如 OpenAI）与境外检索服务：Tavily（网页检索，美国）、GDELT（新闻索引，美国）、
              Wikipedia（浏览统计，美国）、Hacker News（技术社区索引，美国）。这一路构成数据出境。
            </>,
            <>
              <span className="text-neutral-300">判定不出来时</span>：一律按境内处理。
              宁可少几个检索源，也不在不确定的情况下把查询词送出境。
            </>,
            <>
              <span className="text-neutral-300">首页会回显你的来源信息</span>：搜索框下方显示
              服务器这一次看到的来访地址与属地判定结果，以及据此会用到哪些模型与检索服务。
              这些值只回显给你本人，不写入日志、不写库、不与他人关联 ——
              放在页面上是为了让你能当场核对这个判定对不对。
            </>,
            <>
              <span className="text-neutral-300">境内未接入检索服务时</span>：如果运营方没有配置境内检索的
              密钥，境内访问会退回站内本地演示样本，并在页面上明确标注——同样不会改走境外检索。
            </>,
            <>
              <span className="text-neutral-300">你点开的原文</span>：点击信源会直接跳转到原站，
              此后适用该网站的隐私政策，与本政策无关。
            </>,
          ]}
        />
        <p className="text-neutral-500">
          即便是境内链路，也<span className="text-neutral-300">请不要在查询框输入</span>
          身份证号、护照号、银行卡、手机号、住址、病历、生物特征等个人敏感信息 ——
          查询词会作为检索请求发给第三方，这是这个产品的工作方式。
          我们没有出售数据、没有用户画像广告，也没有把查询历史交给任何数据经纪方。
        </p>
        <p className="text-neutral-500">
          若运营者更换模型或检索服务商、或调整区域分流规则，会在站内公告并更新本页，
          生效日期随之改变。若你认为自己的访问被判定到了错误的区域，可联系上方邮箱，我们会核查。
        </p>
      </LegalSection>

      <LegalSection heading="四、账号级历史（只对你可见）">
        <p>
          这一节单独列出来，是因为历史记录最容易变成「说好只存索引，实际上什么都存了」。
          下面两张清单可以直接对着代码核对：存储在服务器的 SQLite 数据库
          （<code>.data/probe.db</code>）里，与账号密码的文件分开。
        </p>
        <p className="text-neutral-300">会保存的（每条提问一行）：</p>
        <LegalList
          items={[
            <>提问原文。默认保存 —— 历史对你有用的前提是「认得出来那是哪一次」。
              运营方可以把 <code>PROBE_HISTORY_STORE_QUERY</code> 设为 0，此后只留时间与计数，
              列表中显示「（已隐去）」。</>,
            <>时间、当次访问被判定为境内还是境外、用的是哪个模型端点、意图类型。</>,
            <>断言计数：抽出多少条、判成支持 / 矛盾 / 未核验各多少条，以及降级原因码。</>,
            <>信源清单：每条的网址、标题、来自哪个检索源；引文只保存一段哈希，不保存原句。</>,
            <>文档核验只保存文档标题、字数、正文的哈希与三态计数。</>,
          ]}
        />
        <p className="text-neutral-300">不会保存的：</p>
        <LegalList
          items={[
            <>摘要正文、数据面板内容、翻译结果等一切由模型生成的内容。</>,
            <>信源原文、抓取到的文章正文、核验过程中的证据片段。</>,
            <>你的来访 IP、User-Agent（历史表里没有这两列）。</>,
          ]}
        />
        <p className="text-neutral-500">
          只有你自己能读到自己的历史：换一个账号访问同一条记录，服务端返回的是「没有这条」
          而不是「无权访问」—— 后者等于承认这条记录存在。运营方可以在后台看到记录总量与库体积，
          但不提供按账号浏览历史原文的界面。
        </p>
      </LegalSection>

      <LegalSection heading="五、关注的实体（只对你可见）">
        <p>
          你可以把某个公司、技术或人物加进「关注」。之后热榜里出现它，服务器会记一条命中，
          在「账号」页的「我的关注」里提示你。这里的每一项同样可以对着代码核对。
        </p>
        <p className="text-neutral-300">会保存的（每次命中一行）：</p>
        <LegalList
          items={[
            <>你关注的名字，以及由它扩展出的别名（例如「台积电」与「TSMC」算同一个关注）。</>,
            <>命中的那条热榜标题、链接、来源站点、当时的热度分数与发布时间。</>,
            <>这条命中是何时记下的、你是否已经读过。</>,
          ]}
        />
        <p className="text-neutral-300">不会保存的：</p>
        <LegalList
          items={[
            <>被命中文章的任何正文内容 —— 我们只留标题与链接，判断留给你。</>,
            <>你的邮箱、手机号或任何推送地址（站内提示，不发邮件、不发短信、不调 Webhook）。</>,
            <>「你为什么关注它」这类推断 —— 关注是一件明说的事，不做画像。</>,
          ]}
        />
        <p className="text-neutral-500">
          歧义词（苹果、小米、长城这类）在没有明确上下文时不推：标题里出现这个词但看不出是哪一家，
          我们只记一次「歧义」，不入库也不提示。漏推一次可以接受，推错一次是造谣。
          关注只对你自己可见：换一个账号访问同一个关注，服务端返回「没有这条」。
        </p>
      </LegalSection>

      <LegalSection heading="六、保存多久">
        <LegalList
          items={[
            <>账号信息：保存到你注销账号，或运营者依约终止服务为止。</>,
            <>审计记录：仅保留最近 2000 条，超出后最早的记录被覆盖。</>,
            <>
              协议确认记录：保存两年（或至协议版本被替换后一年），用于举证；单个文件超过 8MB 时
              只保留最近一轮，不长期归档。
            </>,
            <>
              账号级历史：保留 90 天（运营方可调），每人最多 500 条，超出后最旧的先删；
              过期记录由定时任务清理。删除即从数据库中消失，不进回收站。
              出于故障恢复需要，数据库会随全站备份打包，备份最多保留 14 份。
            </>,
            <>
              关注命中：保留 30 天（运营方可调），每个关注最多留 50 条，超出后最旧的先删。
              取消关注会连同它的命中一起删除，不留孤儿记录。
            </>,
            <>检索缓存：到期即失效，不归档、不用于训练。</>,
            <>反馈文件：保存至运营者归档或删除；写满上限后停止接收而不是无限增长。</>,
            <>
              服务器访问日志：由部署方按《网络安全法》要求留存不少于 6 个月，
              用于安全审计与故障排查，到期轮转删除。
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection heading="七、你的权利">
        <LegalList
          items={[
            <>查询与复制：可以要求提供我们保存的、与你账号相关的信息副本；
              「账号」页的「我的历史」里可以直接一键导出全部历史（JSON）。</>,
            <>删除历史：每条记录都能单独删，也可以一次清空 —— 不需要申请，立即生效。</>,
            <>更正：用户名之外的资料如有错误，可要求更正。</>,
            <>删除与注销：可以要求删除账号及关联数据；我们会在 15 个工作日内处理完毕，
              法律法规要求留存的日志除外。</>,
            <>撤回同意：撤回后你仍可使用服务，但涉及出境的生成能力将不可用。</>,
          ]}
        />
      </LegalSection>

      <LegalSection heading="八、未成年人">
        <p>
          本站面向成年技术用户，不主动面向未成年人推广。不满 14 周岁的未成年人
          应在监护人同意与指导下使用；若我们发现账号属于此类情形且未获同意，
          会停止服务并删除相关数据。
        </p>
      </LegalSection>

      <LegalSection heading="九、我们怎么保护它">
        <LegalList
          items={[
            <>密码单向哈希（scrypt）、会话令牌只存哈希、Cookie 不可被脚本读取。</>,
            <>所有认证与检索接口按来源限流，异常频率会被拒绝而不是排队。</>,
            <>授权数据目录权限 0600，仅服务进程可读；对外只暴露一个反向代理端口。</>,
            <>发生个人信息泄露、篡改或丢失时，我们会按法律要求告知你并向主管部门报告。</>,
          ]}
        />
      </LegalSection>

      <LegalSection heading="十、政策的变更">
        <p>
          本政策如有实质性变更（新增数据用途、更换模型或检索服务商、改变保存期限），
          会在站内公告并更新本页顶部的生效日期；继续使用即视为接受变更后的版本。
        </p>
      </LegalSection>
    </LegalShell>
  );
}
