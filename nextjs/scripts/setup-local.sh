#!/bin/bash
# 设置本地开发环境：链接本地数据 + 本地 webtex-cn
# 用法: bash scripts/setup-local.sh [book-index-draft路径] [webtex-cn路径]
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NEXTJS_DIR="$(dirname "$SCRIPT_DIR")"
DRAFT_DIR="${1:-$NEXTJS_DIR/../../book-index-draft}"
WEBTEX_DIR="${2:-$NEXTJS_DIR/../../webtex-cn}"

echo "Setting up local development environment..."

# 链接 book 数据
if [ -d "$DRAFT_DIR" ]; then
  DRAFT_DIR="$(cd "$DRAFT_DIR" && pwd)"
  ln -sfn "$DRAFT_DIR" "$NEXTJS_DIR/public/local-data"
  ln -sfn "$DRAFT_DIR/Book" "$NEXTJS_DIR/public/books"
  echo "  Book data linked: $DRAFT_DIR"
else
  echo "  Warning: book-index-draft not found at $DRAFT_DIR (skip)"
fi

# 链接 webtex-cn 本地源码（替换 npm 包）
if [ -d "$WEBTEX_DIR" ]; then
  WEBTEX_DIR="$(cd "$WEBTEX_DIR" && pwd)"
  cd "$NEXTJS_DIR" && npm install "$WEBTEX_DIR"
  echo "  webtex-cn linked: $WEBTEX_DIR"
else
  echo "  Warning: webtex-cn not found at $WEBTEX_DIR (skip)"
fi

# 创建 .env.local
echo "NEXT_PUBLIC_MODE=local" > "$NEXTJS_DIR/.env.local"
echo "  Created .env.local with NEXT_PUBLIC_MODE=local"
echo "Done! Run 'npm run dev' to start."
