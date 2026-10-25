import type { ReactNode } from "react";

import { LegalCallout, LegalList, LegalSection, LegalShell } from "@/components/LegalDoc";
import { renderInline, type LegalContext } from "./inline";
import type { LegalBlock, LegalDoc } from "./types";

/**
 * 把 LegalDoc 数据渲染成页面。
 *
 * 为什么要过这一层，而不是直接在 use/terms 里写 JSX：
 * 协议版本号是**正文的哈希**（见 version.ts）。如果正文写在 JSX 里，
 * 「算哈希用的字符串」和「用户看到的字」就是两份来源，改一处忘另一处，
 * 就会出现「内容变了、版本号没变、旧同意继续有效」这种最难查的事故。
 * 现在正文只有一份数据，哈希与渲染都读它，物理上不可能不同步。
 *
 * 行内标记（加粗、五个占位符）在 inline.tsx 里做，那边没有页面壳依赖，测试直接打。
 */

export type { LegalContext };

function Block({ block, ctx, lang }: { block: LegalBlock; ctx: LegalContext; lang: LegalDoc["lang"] }) {
  if (block.kind === "list") {
    return (
      <LegalList
        items={block.items.map((item, i) => (
          <span key={i}>{renderInline(item, ctx, lang)}</span>
        ))}
      />
    );
  }
  if (block.kind === "callout") {
    return <LegalCallout>{renderInline(block.text, ctx, lang)}</LegalCallout>;
  }
  return <p>{renderInline(block.text, ctx, lang)}</p>;
}

export function LegalDocView({
  doc,
  ctx,
  brand,
  meta,
  nav,
  actions,
}: {
  doc: LegalDoc;
  ctx: LegalContext;
  brand?: string;
  meta?: ReactNode;
  nav?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <LegalShell
      title={doc.title}
      updated={ctx.effective}
      brand={brand}
      meta={meta}
      nav={nav}
      actions={actions}
      intro={<p>{renderInline(doc.intro, ctx, doc.lang)}</p>}
    >
      {doc.sections.map((section, i) => (
        <LegalSection key={i} heading={renderInline(section.heading, ctx, doc.lang)}>
          {section.blocks.map((block, j) => (
            <Block key={j} block={block} ctx={ctx} lang={doc.lang} />
          ))}
        </LegalSection>
      ))}
    </LegalShell>
  );
}
