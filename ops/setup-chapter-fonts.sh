#!/usr/bin/env bash
# 章生僻字子集字体（GUJI-701 起；GUJI-721 字源换成 Jigmo 2025.9.12）：bundle-data.mjs 要的 hb-subset／fontTools 与 Jigmo 三档 TTF。
# 三处打包（data.yml 的 package 与 h1 文本两个 job、deploy.yml）都在「打包数据」之前跑本脚本：产物要逐字节一致，
# 所以版本锁死（工具版本不同，子集字节会不同）；装完写 GITHUB_ENV，并设 KYG_CHAPTER_FONTS=required——缺依赖时打包直接失败，不静默少字体。
# 用 venv：ubuntu-latest 的系统 Python 拒绝 pip install --user（PEP 668）。
#
# Jigmo 先取官方压缩包（https://kamichikoichi.github.io/jigmo/），取不到再取 npm 的 fontpkg-jigmo（三个 TTF 与官方包逐字节相同）；
# 两条路都按下面的 SHA-256 逐个核对 TTF，对不上就失败。Jigmo 是 CC0（公有领域奉献），子集、托管不受限制。
set -euo pipefail
D="${RUNNER_TEMP:-/tmp}/chapter-fonts"
JIGMO_VERSION=20250912
JIGMO_ZIP_SHA256=5744c7386d129475d87607ca66d043c8793c65448adeaedc921b6931890e5d0b
python3 -m venv "$D/venv"
"$D/venv/bin/pip" install -q --disable-pip-version-check fonttools==4.67.0 brotli==1.2.0 uharfbuzz==0.56.3
J="$D/jigmo"
mkdir -p "$J"
if curl -fsSL --retry 3 -o "$D/jigmo.zip" "https://kamichikoichi.github.io/jigmo/Jigmo-$JIGMO_VERSION.zip" \
  && echo "$JIGMO_ZIP_SHA256  $D/jigmo.zip" | sha256sum -c --quiet; then
  unzip -q -j -o "$D/jigmo.zip" '*.ttf' -d "$J"   # -j：不管包里有没有子目录，TTF 都平铺到 $J
  SRC="官方压缩包"
else
  (cd "$D" && npm pack "fontpkg-jigmo@2025.9.12" --silent > /dev/null && tar xzf fontpkg-jigmo-2025.9.12.tgz)
  cp "$D/package/Jigmo.ttf" "$D/package/Jigmo2.ttf" "$D/package/Jigmo3.ttf" "$J/"
  SRC="npm fontpkg-jigmo@2025.9.12"
fi
(cd "$J" && sha256sum -c --quiet <<'SUMS'
c8f295b9bd8f9f117a76b3a454aaaa1bb5b4babc18e254978c6deb88464e40cf  Jigmo.ttf
5da3582efe77e22073b86b3b86b556d7111148a76b957cfb53318a91da2efff0  Jigmo2.ttf
815b18c1c670103723fe743090559208fdea47dc587ecb057a5a4721ee8dfeff  Jigmo3.ttf
SUMS
)
{
  echo "KYG_FONT_PYTHON=$D/venv/bin/python"
  echo "JIGMO_DIR=$J"
  echo "KYG_FONT_CACHE=${RUNNER_TEMP:-/tmp}/zi-font-cache"   # 与 workflow 里 actions/cache 的 path 一致
  echo "KYG_CHAPTER_FONTS=required"
} >> "${GITHUB_ENV:-/dev/null}"
echo "✔ chapter-fonts 依赖就绪：$("$D/venv/bin/python" -c 'import fontTools, uharfbuzz; print("fontTools", fontTools.version, "uharfbuzz", uharfbuzz.__version__)')，Jigmo $JIGMO_VERSION（$SRC）"
