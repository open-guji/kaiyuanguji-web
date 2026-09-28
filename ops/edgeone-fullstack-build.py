#!/usr/bin/env python3
"""全栈（直接上传型）EdgeOne Pages 项目的 `makers build`：把控制台里配的项目环境变量带进边缘函数。

为什么需要（E1，2026-09-27）：
edgeone@1.6.41 的 `makers build` 编译 edge-functions 时，把**构建进程的整份 process.env**
（外加 ./.env 里没被 process.env 覆盖的键）当作字面量写进 `.edgeone/edge-functions/index.js`，
运行时函数拿到的 `context.env` 就是这份快照；控制台上配的项目变量在运行时**不会**再注入。
所以 kyg-staging／kyg-ssr-spike 控制台明明配了 AUTH_JWT_SECRET，/api/auth/me 仍是 503。
副作用更糟：CI 构建步骤环境里有什么（例如 EDGEONE_API_TOKEN）就原样烘进了函数代码。

本脚本的做法：
1. 用 EDGEONE_API_TOKEN 读项目环境变量（与 CLI `env pull` 同一接口 DescribePagesProjectEnvs），
   只留作用于 production（或不分环境）的；值只在内存里，不写文件、不打印。
   不用 `makers env pull` 写 .env：Next standalone 会把 .env 原样复制进
   `.edgeone/cloud-functions/ssr-node/`，而且 ./.env 也不能阻止 process.env 整份被烘进去。
2. 用**白名单**环境跑构建命令：PATH/HOME 等基础变量 ＋ NEXT_PUBLIC_*／KYG_*／SITEMAP_* ＋ 项目变量。
   CI 的其余变量（token、secret）进不了子进程，自然也进不了产物。
3. 构建后查产物（值只在内存里比对，报错只报变量名＋sha256 前 12 位）：
   - 产物里不得有任何 `.env*` 文件；
   - 项目变量的值只许出现在 `.edgeone/edge-functions/` 下，assets／cloud-functions 里一律不许有；
   - `--forbid-env` 点名的 CI 变量（如 EDGEONE_API_TOKEN）的值在产物任何位置都不许有；
   - 每个项目变量都必须真的进了 edge-functions/index.js（否则等于没修）。

用法（在 nextjs/ 下）：
  EDGEONE_API_TOKEN=... python3 ../ops/edgeone-fullstack-build.py -n kyg-staging \\
      --forbid-env EDGEONE_API_TOKEN -- npx -y edgeone@1.6.41 makers build
本地试验可用 --env-json 文件代替读接口（{"KEY": "value"}）。
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "https://pages-api.edgeone.ai/v1"

# 子进程（makers build → next build ＋ 边缘函数编译）能看到的 CI 变量：只放构建真要用的
PASS_EXACT = {
    "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "CI", "RUNNER_TEMP",
    "NODE_OPTIONS", "NODE_ENV", "NEXT_TELEMETRY_DISABLED", "npm_config_cache",
}
PASS_PREFIXES = ("NEXT_PUBLIC_", "KYG_", "SITEMAP_")
# 这些键就算控制台里配了也不带进函数（CLI 自己也会删 TENCENT_SECRET_*）
NEVER_KEYS = {"TENCENT_SECRET_ID", "TENCENT_SECRET_KEY", "EDGEONE_API_TOKEN"}
KEY_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")
# 短于此长度的值（如 "1"、"true"）做子串比对只会误报，不查
MIN_SCAN_LEN = 8
EDGE_DIR = "edge-functions"


def log(msg):
    print(msg, flush=True)


def tag(value):
    return hashlib.sha256(value.encode()).hexdigest()[:12]


def call(token, action, **params):
    body = json.dumps({"Action": action, **params}).encode()
    last = None
    for attempt in range(3):
        req = urllib.request.Request(API, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
            break
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            time.sleep(5 * (attempt + 1))
    else:
        sys.exit(f"✗ {action}: 请求失败 {type(last).__name__}")
    resp = (data.get("Data") or {}).get("Response") or data
    if resp.get("Error"):
        err = resp["Error"]
        sys.exit(f"✗ {action}: {err.get('Code')} {err.get('Message')}")
    return resp


def project_id(token, name):
    page, hits = 1, []
    while True:
        items = call(token, "DescribePagesProjects", PageNumber=page, PageSize=50).get("Projects") or []
        hits += [p for p in items if p.get("Name") == name]
        if len(items) < 50:
            break
        page += 1
    if len(hits) != 1:
        sys.exit(f"✗ 项目名 {name!r} 匹配到 {len(hits)} 个")
    return hits[0]["ProjectId"]


def select_vars(env_vars, environment="production"):
    """接口返回的 EnvVars → {key: value}：只留作用于 environment（或不分环境）的合法键。"""
    out = {}
    for e in env_vars:
        key, value = e.get("Key") or "", e.get("Value")
        # 接口里是首字母大写的 "Production"／"Preview"（ModifyPagesProjectEnvs 也这么写），比较不分大小写
        envs = [str(x).lower() for x in (e.get("Env") or [])]
        if envs and environment.lower() not in envs:
            continue
        if not KEY_RE.match(key) or key in NEVER_KEYS or not isinstance(value, str):
            continue
        out[key] = value
    return out


def child_env(parent, project_vars, extra_pass=()):
    env = {k: v for k, v in parent.items()
           if k in PASS_EXACT or k in extra_pass or k.startswith(PASS_PREFIXES)}
    clash = sorted(k for k in project_vars if k in env)
    for k, v in project_vars.items():
        env.setdefault(k, v)  # 构建配置（NEXT_PUBLIC_* 等）以 CI 为准
    return env, clash


def _js(value):
    """与 JS 的 JSON.stringify 同形（非 ASCII 不转义）。"""
    return json.dumps(value, ensure_ascii=False)


def _forms(value):
    """值在文件里可能的两种样子：原样、JSON 字符串转义后（去掉两头引号）。"""
    return {value.encode(), _js(value)[1:-1].encode()}


def scan_bundle(root, project_vars, forbidden):
    """返回问题列表（只含路径、变量名、sha 前缀，不含值）；并核对每个项目变量已进边缘函数。"""
    problems = []
    proj = {k: _forms(v) for k, v in project_vars.items() if len(v) >= MIN_SCAN_LEN}
    forb = {k: _forms(v) for k, v in forbidden.items() if len(v) >= MIN_SCAN_LEN}
    edge_prefix = os.path.join(root, EDGE_DIR) + os.sep
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, root)
            if fn.startswith(".env"):
                problems.append(f"产物里有环境变量文件：{rel}")
            try:
                with open(path, "rb") as f:
                    data = f.read()
            except OSError:
                continue
            for k, forms in forb.items():
                if any(v in data for v in forms):
                    problems.append(f"CI 变量 {k}（sha {tag(forbidden[k])}）的值出现在 {rel}")
            if not path.startswith(edge_prefix):
                for k, forms in proj.items():
                    if any(v in data for v in forms):
                        problems.append(f"项目变量 {k}（sha {tag(project_vars[k])}）的值出现在边缘函数之外：{rel}")
    index = os.path.join(root, EDGE_DIR, "index.js")
    if project_vars:
        try:
            with open(index, encoding="utf-8") as f:
                code = f.read()
        except OSError:
            problems.append(f"没有 {EDGE_DIR}/index.js：边缘函数没编译出来")
            code = None
        if code is not None:
            for k, v in project_vars.items():
                if f"{_js(k)}:{_js(v)}" not in code:
                    problems.append(f"项目变量 {k} 没有进 {EDGE_DIR}/index.js 的 context.env")
    return problems


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-n", "--project", help="EdgeOne Pages 项目名（从接口读变量）")
    ap.add_argument("--env-json", help="本地试验：从 JSON 文件读项目变量，代替接口")
    ap.add_argument("--environment", default="production", choices=["production", "preview"])
    ap.add_argument("--forbid-env", action="append", default=[],
                    help="CI 变量名：其值在产物任何位置都不许出现（可多次）")
    ap.add_argument("--require", action="append", default=[],
                    help="必须从项目读到的变量名：缺了直接失败，别让「没带上变量」静默通过（可多次）")
    ap.add_argument("--pass-env", action="append", default=[], help="额外放进构建子进程的变量名")
    ap.add_argument("--out", default=".edgeone", help="构建产物目录")
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--retry-sleep", type=int, default=20)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    cmd = a.cmd[1:] if a.cmd[:1] == ["--"] else a.cmd
    if not cmd:
        ap.error("缺构建命令（写在 -- 之后）")

    if a.env_json:
        with open(a.env_json, encoding="utf-8") as f:
            raw = json.load(f)
        project_vars = select_vars([{"Key": k, "Value": v} for k, v in raw.items()], a.environment)
    elif a.project:
        token = os.environ.get("EDGEONE_API_TOKEN")
        if not token:
            sys.exit("✗ 缺 EDGEONE_API_TOKEN")
        pid = project_id(token, a.project)
        project_vars = select_vars(call(token, "DescribePagesProjectEnvs", ProjectId=pid).get("EnvVars") or [],
                                   a.environment)
    else:
        ap.error("要么 -n 项目名，要么 --env-json")

    if os.environ.get("GITHUB_ACTIONS") == "true":
        for v in project_vars.values():
            if len(v) >= 4 and "\n" not in v:
                print(f"::add-mask::{v}", flush=True)
    log(f"· 项目变量 {len(project_vars)} 个（{a.environment}）：{' '.join(sorted(project_vars)) or '无'}")
    missing = [k for k in a.require if not project_vars.get(k)]
    if missing:
        sys.exit(f"❌ 项目里没有读到必需的变量：{' '.join(missing)}（控制台是否配了、是否作用于 {a.environment}）")

    env, clash = child_env(os.environ, project_vars, set(a.pass_env))
    if clash:
        log(f"⚠️ 以下键 CI 构建配置里已有，以 CI 为准、不用控制台值：{' '.join(clash)}")
    dropped = sorted(k for k in os.environ if k not in env)
    log(f"· 构建子进程环境 {len(env)} 个键；未传入的 CI 变量 {len(dropped)} 个")

    n = 1
    while True:
        rc = subprocess.call(cmd, env=env)
        if rc == 0:
            break
        if n >= a.retries:
            sys.exit(f"❌ 构建重试 {a.retries} 次仍失败（exit {rc}）")
        log(f"⚠️ 构建第 {n} 次失败（exit {rc}），{a.retry_sleep} 秒后重试（下一次 {n + 1}/{a.retries}）")
        time.sleep(a.retry_sleep)
        n += 1

    forbidden = {k: os.environ[k] for k in a.forbid_env if os.environ.get(k)}
    problems = scan_bundle(a.out, project_vars, forbidden)
    if problems:
        for p in problems:
            log(f"❌ {p}")
        sys.exit(1)
    log(f"✓ 产物无 .env；{len(project_vars)} 个项目变量都已进边缘函数且只在其中；"
        f"{len(forbidden)} 个 CI 机密变量未出现在产物里")


if __name__ == "__main__":
    main()
