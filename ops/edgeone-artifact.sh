#!/usr/bin/env bash
# 全栈产物（nextjs/.edgeone）打包加密／解密解包——正式站复用测试站那次 run 构建好的产物（overview#341）。
#
# 为什么要加密：E1 起项目环境变量（AUTH_JWT_SECRET 等）在构建期烘进边缘函数（见 ops/edgeone-fullstack-build.py），
# 产物里有机密。Actions 工件对有仓库读权限的人都能下载，所以只存密文。
# 密钥由 EDGEONE_API_TOKEN 派生（HMAC，与条目页失效密钥同一做法），不另建 secret；能部署的 run 才解得开。
# 完整性：明文 tar 包的 sha256 单独存（*.sha256），解包前核对——AES-CBC 本身不防篡改／截断。
#
# 用法（都要 EDGEONE_API_TOKEN）：
#   ops/edgeone-artifact.sh pack   <含 .edgeone 的目录> <输出文件.enc>   # 另写 <输出文件.enc>.sha256
#   ops/edgeone-artifact.sh unpack <输入文件.enc> <目标目录>              # 解到 <目标目录>/.edgeone（先删旧的）
set -euo pipefail

cmd="${1:-}"
if [ -z "${EDGEONE_API_TOKEN:-}" ]; then
  echo "❌ 缺 EDGEONE_API_TOKEN（产物密钥由它派生）" >&2
  exit 2
fi
KYG_ARTIFACT_KEY=$(printf 'kyg-prod-artifact' | openssl dgst -sha256 -hmac "$EDGEONE_API_TOKEN" | awk '{print $NF}')
export KYG_ARTIFACT_KEY
ENC=(openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

case "$cmd" in
  pack)
    src="${2:?用法：pack <含 .edgeone 的目录> <输出文件.enc>}"
    out="${3:?用法：pack <含 .edgeone 的目录> <输出文件.enc>}"
    [ -d "$src/.edgeone" ] || { echo "❌ $src/.edgeone 不存在" >&2; exit 1; }
    tar -C "$src" -czf "$TMP/edgeone.tgz" .edgeone
    sha=$(sha256sum "$TMP/edgeone.tgz" | awk '{print $1}')
    "${ENC[@]}" -salt -pass env:KYG_ARTIFACT_KEY -in "$TMP/edgeone.tgz" -out "$out"
    echo "$sha" > "$out.sha256"
    echo "✓ 已打包：$out（$(du -h "$out" | cut -f1)，$(find "$src/.edgeone" -type f | wc -l) 个文件，明文 sha256 ${sha:0:16}…）"
    ;;
  unpack)
    in="${2:?用法：unpack <输入文件.enc> <目标目录>}"
    dest="${3:?用法：unpack <输入文件.enc> <目标目录>}"
    [ -f "$in" ] && [ -f "$in.sha256" ] || { echo "❌ 缺 $in 或 $in.sha256" >&2; exit 1; }
    "${ENC[@]}" -d -pass env:KYG_ARTIFACT_KEY -in "$in" -out "$TMP/edgeone.tgz" \
      || { echo "❌ 解密失败（密钥不对？产物不是用同一个 EDGEONE_API_TOKEN 打的？）" >&2; exit 1; }
    want=$(tr -d '[:space:]' < "$in.sha256")
    got=$(sha256sum "$TMP/edgeone.tgz" | awk '{print $1}')
    [ "$want" = "$got" ] || { echo "❌ 产物校验不符（sha256 应为 $want，实为 $got）" >&2; exit 1; }
    rm -rf "$dest/.edgeone"
    tar -C "$dest" -xzf "$TMP/edgeone.tgz"
    echo "✓ 已解包到 $dest/.edgeone（$(find "$dest/.edgeone" -type f | wc -l) 个文件，sha256 ${got:0:16}… 核对一致）"
    ;;
  *)
    echo "用法：$0 pack <目录> <输出.enc> | unpack <输入.enc> <目录>" >&2
    exit 2
    ;;
esac
