// jest mock — book-index-ui 0.2.25 顶层 require react-markdown（ESM-only）
// 测试不验证 markdown 渲染，返回最小 stub 即可
const React = require('react');
module.exports = function ReactMarkdown({ children }) {
    return React.createElement('div', null, children);
};
module.exports.default = module.exports;
