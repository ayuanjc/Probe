"use client";

/**
 * 「这是什么」—— 陌生人第一次落到登录页时，眼前只有一个用户名/密码框和一行
 * 「仅限受邀用户使用」。他不知道自己在申请什么，也不知道进去之后会看到什么。
 *
 * 所以这里回答三件事：搜出来的是什么、凭什么可信、什么时候不该信。
 * 形式上用 <details>：首屏只占一行，想了解的人自己展开 —— 登录框仍然是主角。
 *
 * 文案口径与页脚、隐私政策保持一致：内容由模型生成、以原始信源为准。
 * 这不是免责声明式的叠甲，是这个产品唯一诚实的卖点。
 */

const POINTS: { k: string; v: string }[] = [
  {
    k: "回去的不是一段总结",
    v: "结论、时间线、关键数字、实体关系、原文引用 —— 每一样都落在面板上，能看、能点、能复核。",
  },
  {
    k: "每条断言都挂着证据",
    v: "检索到原文之后逐条找留出集证据，判成支持 / 矛盾 / 无法判定；找不到证据的不会被说成「查无此事」。",
  },
  {
    k: "数字点得回原文",
    v: "面板里的每个数都记着它来自哪一条信源；原文改了，面板跟着变 —— 这是它跟「生成一段话」的区别。",
  },
];

export default function WhatIsThis() {
  return (
    <details className="group rounded-md border border-neutral-800 bg-[#0f0f0f] px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-mono text-[11px] text-neutral-500 transition-colors hover:text-neutral-300 group-open:text-neutral-300">
        <span aria-hidden className="inline-block transition-transform duration-150 group-open:rotate-90">
          ▸
        </span>
        这是什么？
      </summary>

      <div className="mt-3 space-y-3 border-t border-neutral-800 pt-3">
        <p className="text-[12px] leading-relaxed text-neutral-300">
          它不替你做判断，只把「这个结论站在哪几条原文上」摆出来，
          让你自己看完再决定信不信。
          <span className="text-neutral-500">（上面那句不是标语，是它跟聊天机器人的唯一区别。）</span>
        </p>

        <dl className="space-y-2">
          {POINTS.map((p) => (
            <div key={p.k} className="flex gap-2">
              <dt className="mt-[3px] shrink-0 font-mono text-[10px] text-blue-500/70">—</dt>
              <dd className="text-[11.5px] leading-relaxed text-neutral-400">
                <span className="text-neutral-200">{p.k}：</span>
                {p.v}
              </dd>
            </div>
          ))}
        </dl>

        <p className="font-mono text-[10px] leading-relaxed text-neutral-600">
          面板内容由模型生成，可能出错；判断事情请以原始信源为准。
        </p>
      </div>
    </details>
  );
}
