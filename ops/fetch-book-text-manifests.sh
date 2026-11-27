#!/usr/bin/env bash
# 只取 book-text 里的 manifest.json 与 default/index.json（几百 KB），供「自做书名单」自动推出用：
#   ops/iiif/original_books.py 读它们，找出 is_original 的书。
# 用法：ops/fetch-book-text-manifests.sh <目标目录> [分支…]（默认先 dev、取不到再 main；新书先进 dev，每日才并 main）
set -euo pipefail
dest=${1:?用法：$0 <目标目录> [分支…]}
shift || true
refs=("$@")
[ ${#refs[@]} -gt 0 ] || refs=(dev main)
for ref in "${refs[@]}"; do
  rm -rf "$dest"
  if git clone -q --depth 1 --filter=blob:none --no-checkout --branch "$ref" https://github.com/open-guji/book-text.git "$dest" 2>/dev/null; then
    git -C "$dest" sparse-checkout set --no-cone '/Book/*/*/*/*/manifest.json' '/Book/*/*/*/*/default/index.json'
    git -C "$dest" checkout -q "$ref"
    echo "· book-text@$ref：$(find "$dest/Book" -name manifest.json | wc -l) 本" >&2
    exit 0
  fi
  echo "· book-text 没有分支 $ref，试下一个" >&2
done
echo "❌ 取不到 book-text（试过：${refs[*]}）" >&2
exit 1
