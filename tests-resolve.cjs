// 测试期把 "@/xxx" 解析到编译产物 .tmp/test-build/src/xxx。
// tsc 不会重写 paths 别名（emit 只做类型擦除），所以没有这一层时任何用到 "@/lib/..." 的
// 模块在 node --test 里都会 MODULE_NOT_FOUND。生产构建由 Next 处理别名，不受影响。
const Module = require("node:module");
const path = require("node:path");

const SRC = path.join(__dirname, ".tmp", "test-build", "src");
const resolve = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === "string" && request.startsWith("@/")) {
    return resolve.call(this, path.join(SRC, request.slice(2)), parent, isMain, options);
  }
  return resolve.call(this, request, parent, isMain, options);
};
