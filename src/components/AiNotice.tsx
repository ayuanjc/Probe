/**
 * AI 生成标识：一条角标 + 一句限定。
 *
 * 为什么单独抽出来：它要出现在摘要、面板、翻译三处，样式必须一致 ——
 * 三处各写一遍，半年后必然长成三种样子。而《生成式人工智能服务管理暂行办法》
 * 第十二条要求对生成内容作显著标识，标识长得不统一，等于告诉检查的人
 * “这里没人管过”。
 *
 * 不是警告色。本站的前提是“模型只是排版与串联，数字都能点回原文”，
 * 用红色反倒暗示结果不可信；蓝色与产品强调色同族，位置在内容之上，
 * 读第一句之前就先看到它。
 */
export default function AiNotice({ note }: { note?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="border border-blue-500/30 bg-blue-500/[0.08] px-1.5 py-0.5 font-mono text-[10px] leading-none text-blue-400">
        AI 生成
      </span>
      <span className="font-mono text-[10px] text-neutral-600">
        {note ?? "模型撰写 · 仅供参考，请以原始信源为准"}
      </span>
    </div>
  );
}
