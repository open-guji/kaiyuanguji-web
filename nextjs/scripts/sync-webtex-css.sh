#!/bin/bash
# 将 webtex-cn 的 CSS 模板同步到 public/webtex-css/
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NEXTJS_DIR="$(dirname "$SCRIPT_DIR")"
SOURCE="$NEXTJS_DIR/../../webtex-cn/src/templates"
TARGET="$NEXTJS_DIR/public/webtex-css"

if [ ! -d "$SOURCE" ]; then
  echo "Warning: webtex-cn templates not found at $SOURCE"
  exit 0
fi

mkdir -p "$TARGET"
cp "$SOURCE"/*.css "$TARGET/"
echo "Synced CSS templates to public/webtex-css/"
