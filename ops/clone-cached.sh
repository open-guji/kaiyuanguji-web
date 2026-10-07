#!/usr/bin/env bash
# 克隆数据仓（带 actions/cache 里取回的 .git 做增量）——overview#470 P1。用法：source ops/clone-cached.sh; clone_cached <仓名> <目录> <ref>
# 背景：book-text 浅拉要现压 1.75 GB 的包，实测 08:15 2.6 分 → 16:27 23 分（同一个 commit，随 GitHub 负载忽快忽慢）。
# 工作流把 <目录>/.git 放进 actions/cache（键＝仓名＋commit，取最近一份）；这里在已有对象上只拉新增的，同一个 commit 直接复用，
# 取不到或缓存太大（防只增不减）就全量浅拉。缓存只存 .git，工作区文件每次由 checkout 还原。
# deploy.yml 的 build／prod-artifact 内联了同一份（它们检出的可能是更早的 web 提交，那一版没有本文件）；data.yml 直接 source 本文件。
# 下面 begin／end 之间的文字，内联两份必须与此逐字一致（ops/tests/test_clone_cache.py）。
# --- clone_cached:begin（overview#470 P1。正本是 ops/clone-cached.sh；deploy.yml 的 build、prod-artifact 内联两份同文——build 检出的可能是更早的 web 提交，那一版没有这个文件——ops/tests/test_clone_cache.py 守着）
set -o pipefail
GIT_BASE_URL="${GIT_BASE_URL:-https://github.com/open-guji}"
GIT_CACHE_MAX_MB="${GIT_CACHE_MAX_MB:-4096}"
# git 的 --progress 输出带回车、刷得很密：只留每 15 秒一行（和结束那行）
git_progress() {
  local last=-99 line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [ $((SECONDS - last)) -ge 15 ] || [[ "$line" == *", done"* ]]; then echo "    $line"; last=$SECONDS; fi
  done
}
# clone_cached <仓名> <目录> <ref>：目录里若有从 actions/cache 取回的 .git，就在已有对象上只拉新增的；没有（或太大）就全量浅拉。
# 同一个 commit 缓存里已经有的，不再 fetch。每个仓打印开始、结束、用时和 .git 大小。
clone_cached() {
  local repo="$1" dest="$2" ref="$3" t0=$SECONDS mb
  echo "▶ 克隆 $repo @ ${ref:0:12}"
  if [ -d "$dest/.git" ]; then
    mb=$(du -sm "$dest/.git" | cut -f1)
    if [ "$mb" -gt "$GIT_CACHE_MAX_MB" ]; then
      echo "· 缓存的 .git 已 ${mb} MB，超过 ${GIT_CACHE_MAX_MB} MB 上限，丢弃后全量浅拉"; rm -rf "$dest/.git"
    else
      echo "· 用缓存的 .git（${mb} MB）：只拉新增对象"
    fi
  else
    echo "· 没有缓存：全量浅拉"
  fi
  [ -d "$dest/.git" ] || git init -q "$dest"
  if printf '%s' "$ref" | grep -Eq '^[0-9a-f]{40}$' && git -C "$dest" cat-file -e "${ref}^{commit}" 2>/dev/null; then
    echo "· 缓存里已有这个 commit，不再 fetch"
    git -C "$dest" checkout -q -f "$ref"
  else
    git -C "$dest" fetch --depth 1 --progress "$GIT_BASE_URL/$repo.git" "$ref" 2>&1 | tr '\r' '\n' | git_progress
    git -C "$dest" checkout -q -f FETCH_HEAD
  fi
  echo "✔ $repo 用时 $((SECONDS - t0)) 秒，.git $(du -sh "$dest/.git" | cut -f1)，commit $(git -C "$dest" rev-parse --short=12 HEAD)"
}
# --- clone_cached:end
