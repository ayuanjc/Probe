import type { LangCode } from "./lang";
import type { RiskBand, RiskSignal } from "./translate-risk";

export type TranslateEngine = "llm" | "mymemory" | "none";

/** 正文从哪来：抓到的全文 / 调用方给的文本 / 只有标题与片段。 */
export type DocSource = "fetched" | "provided" | "snippet";

export type TranslatedSegment = {
  i: number;
  src: string;
  dst: string;
  risk: number;
  band: RiskBand;
  signals: RiskSignal[];
};

export type TranslateResult = {
  ok: true;
  title: string;
  url: string;
  from: LangCode;
  to: LangCode;
  fromName: string;
  toName: string;
  needsTranslation: boolean;
  engine: TranslateEngine;
  engineNote: string;
  docSource: DocSource;
  chars: number;
  truncated: boolean;
  degraded: string[];
  segments: TranslatedSegment[];
  overall: { risk: number; band: RiskBand; signals: RiskSignal[] };
};

export type TranslateFailure = {
  ok: false;
  error: string;
  message: string;
};

export type TranslateResponse = TranslateResult | TranslateFailure;
