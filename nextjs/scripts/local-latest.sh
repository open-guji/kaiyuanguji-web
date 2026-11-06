#!/bin/bash
# 一键本地看最新：缺什么拉什么，然后起 dev:latest。本机、云端会话都能跑。
#
#   bash nextjs/scripts/local-latest.sh            # 在仓库根或 nextjs 下都行
#   BIM_BRANCH=feat/xxx bash …/local-latest.sh     # UI 用别的分支（默认 dev，没有则 main）
#   NO_START=1 bash …/local-latest.sh              # 只准备环境，不起服务
#
# 它做的事：
#   1. 把 book-index-manager 浅克隆到网站仓同级目录（已存在则 fetch 并切到目标分支，不动你的未提交改动）
#   2. 装 ui 之外的依赖：网站 nextjs/node_modules（UI 源码的 react 等 peer 依赖解析到这里）
#   3. npm run dev:latest（UI 源码直连、数据读 https://data.openguji.com）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NEXTJS="$(dirname "$HERE")"
REPO="$(dirname "$NEXTJS")"
BIM="${BIM_DIR:-$(dirname "$REPO")/book-index-manager}"
BRANCH="${BIM_BRANCH:-dev}"

if [ ! -d "$BIM/.git" ]; then
  echo "→ 浅克隆 book-index-manager 到 $BIM"
  if ! git clone --depth 1 --branch "$BRANCH" https://github.com/open-guji/book-index-manager "$BIM" 2>/dev/null; then
    echo "  （没有 $BRANCH 分支，改用 main）"
    git clone --depth 1 https://github.com/open-guji/book-index-manager "$BIM"
  fi
else
  echo "→ 更新 $BIM"
  if [ -n "$(git -C "$BIM" status --porcelain)" ]; then
    echo "  有未提交改动，不动它，直接用当前工作区"
  else
    if git -C "$BIM" fetch --depth 1 origin "$BRANCH" 2>/dev/null; then
      git -C "$BIM" checkout -q -B "$BRANCH" FETCH_HEAD
    else
      echo "  远端没有 $BRANCH，保持当前分支 $(git -C "$BIM" branch --show-current)"
    fi
  fi
fi

if [ ! -d "$NEXTJS/node_modules/next" ]; then
  echo "→ 安装网站依赖"
  (cd "$NEXTJS" && npm ci)
fi

[ -n "${NO_START:-}" ] && { echo "已就绪。npm run dev:latest 启动。"; exit 0; }
cd "$NEXTJS"
export BIM_UI_SRC="${BIM_UI_SRC:-$BIM/ui}"
exec npm run dev:latest
