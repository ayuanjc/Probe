import assert from "node:assert/strict";
import test from "node:test";
import { countryLabel } from "@/lib/country-names";
import { joinZh, modelVendor, retrievalLabel } from "@/lib/service-labels";

test("modelVendor：认得出的服务商给名字，认不出的老实显示域名", () => {
  assert.equal(modelVendor("api.deepseek.com"), "DeepSeek");
  assert.equal(modelVendor("API.OpenAI.com"), "OpenAI");
  assert.equal(modelVendor("open.bigmodel.cn"), "智谱 GLM");
  assert.equal(modelVendor("127.0.0.1"), "本机 / 内网模型");
  assert.equal(modelVendor("192.168.1.9"), "本机 / 内网模型");
  assert.equal(modelVendor("llm.internal.example.com"), "llm.internal.example.com");
  assert.equal(modelVendor(""), "未配置");
  assert.equal(modelVendor(undefined), "未配置");
});

test("modelVendor：子域按后缀命中，不能被拼出来的假域名骗过", () => {
  assert.equal(modelVendor("gateway.api.deepseek.com"), "DeepSeek");
  // 形似但不是：必须整段后缀匹配，防止 api.deepseek.com.evil.tld 冒充
  assert.equal(modelVendor("api.deepseek.com.evil.tld"), "api.deepseek.com.evil.tld");
});

test("retrievalLabel：见过的翻中文，没见过的原样留着", () => {
  assert.equal(retrievalLabel("bocha"), "博查");
  assert.equal(retrievalLabel("wiki"), "Wikipedia");
  assert.equal(retrievalLabel("bing"), "bing");
});

test("joinZh：0/1/2/3 个元素都要读得通", () => {
  assert.equal(joinZh([]), "无");
  assert.equal(joinZh(["博查"]), "博查");
  assert.equal(joinZh(["DeepSeek", "博查"]), "DeepSeek 与 博查");
  assert.equal(joinZh(["A", "B", "C"]), "A、B 与 C");
});

test("countryLabel：查得到给中文名，查不到退回码，空值不编", () => {
  assert.equal(countryLabel("CN"), "中国");
  assert.equal(countryLabel("sg"), "新加坡");
  assert.equal(countryLabel("ZZ"), "ZZ");
  assert.equal(countryLabel(""), undefined);
  assert.equal(countryLabel(null), undefined);
});
