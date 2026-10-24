import type { Metadata } from "next";
import VerifyPanel from "@/components/VerifyPanel";
import { requirePageUser } from "@/lib/auth/guard";

/** 文档核验页：粘贴一篇正文或给一个链接，看它自己的断言被外部材料吻合到什么程度。 */
export const metadata: Metadata = {
  title: "文档核验",
  description: "把一篇文章拆成断言，逐条去外部材料里核对，给一个带区间的吻合度。",
};

export const dynamic = "force-dynamic";

export default async function VerifyPage() {
  await requirePageUser();
  return <VerifyPanel />;
}
