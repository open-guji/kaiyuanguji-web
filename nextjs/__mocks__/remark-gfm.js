// jest mock — remark-gfm 是 ESM-only，测试不需要真插件
module.exports = function remarkGfm() { return undefined; };
module.exports.default = module.exports;
