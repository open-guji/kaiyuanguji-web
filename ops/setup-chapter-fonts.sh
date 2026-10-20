#!/usr/bin/env bash
# 对读章生僻字子集字体（GUJI-701）：bundle-data.mjs 要的 fontTools 与 hanamin 字体包。
# 三处打包（data.yml 的 package 与 h1 文本两个 job、deploy.yml）都在「打包数据」之前跑本脚本：产物要逐字节一致，
# 所以版本锁死（fontTools 版本不同，子集字节会不同）；装完写 GITHUB_ENV，并设 KYG_CHAPTER_FONTS=required——缺依赖时打包直接失败，不静默少字体。
# 用 venv：ubuntu-latest 的系统 Python 拒绝 pip install --user（PEP 668）。
set -euo pipefail
D="${RUNNER_TEMP:-/tmp}/chapter-fonts"
python3 -m venv "$D/venv"
"$D/venv/bin/pip" install -q --disable-pip-version-check fonttools==4.67.0 brotli==1.2.0
mkdir -p "$D/hanamin"
(cd "$D/hanamin" && npm pack hanamin@0.0.5 --silent > /dev/null && tar xzf hanamin-0.0.5.tgz)
test -f "$D/hanamin/package/HanaMin.css"
{
  echo "KYG_FONT_PYTHON=$D/venv/bin/python"
  echo "HANAMIN_DIR=$D/hanamin/package"
  echo "KYG_CHAPTER_FONTS=required"
} >> "${GITHUB_ENV:-/dev/null}"
echo "✔ chapter-fonts 依赖就绪：$("$D/venv/bin/python" -c 'import fontTools; print("fontTools", fontTools.version)')，hanamin@0.0.5"
