#!/usr/bin/env python3
"""回滚计划（DBG，rollback.yml 的第一步；也可本地跑，只读、不改任何东西）。

回答三件事：现在线上是哪一版、要退回哪一版、用哪条路退、会连带动什么。

  · 正式站（www）＝全栈项目 kyg-ssr-spike（CUT2，overview#241）。它是 CLI 直传，没有发布分支，
    deploy.yml 每次正式发布在 release-log 分支追加一个空提交，提交信息里带源 commit：
      Released to kyg-ssr-spike from @ open-guji/kaiyuanguji-web@<40 位 sha> 🚀 (…)
    切站前的正式发布是 edgeone-release 分支上的提交（Deploying to edgeone-release from @ …@<sha> 🚀）；
    那段时间 kyg-ssr-spike 每次同版本双跑，所以这段历史接在 release-log 后面照样算数。
    「上一次正式发布的 web commit」＝这份历史里、比当前那版更早的第一个不同的源 commit。
  · 回滚路（method）只剩 promote：把目标 commit 在测试站重建一遍（deploy.yml target=staging，
    跑完整 verify），绿了再 promote=code+data 上正式站（kyg-ssr-spike）。约 20 分钟，走的就是
    平时发版那条路，发布后 e2e 照跑。数据＝测试站此刻的数据（main HEAD），不是回退前那版。
    原来的 release-branch（恢复 edgeone-release 产物）已停用：那条分支发的是旧项目 kaiyuanguji，
    www 已不在它上面。要比 20 分钟更快止血，见 docs/runbook.md §8（控制台操作，不走 CI）。
  · 数据：deploy.yml 目前只接受「测试站指针里记的三仓 commit」或 main HEAD，没有「指定数据
    commit」的入口，所以本计划不单独回退数据（见 PR 描述「要改 deploy.yml 的部分」）。

用法（仓库根，需要完整历史、release-log 与 edgeone-release 分支）：
  git fetch origin main edgeone-release release-log
  python3 ops/rollback-plan.py --target production                    # 退回上一次正式发布
  python3 ops/rollback-plan.py --target staging --web-commit <sha>    # 测试站演练
在 GitHub Actions 里还会把结果写进 $GITHUB_OUTPUT 与 $GITHUB_STEP_SUMMARY。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import code_pointer  # noqa: E402

DATA = "https://data.kaiyuanguji.com"
SITES = {"production": "https://www.kaiyuanguji.com", "staging": "https://staging.kaiyuanguji.com"}
POINTERS = {"production": f"{DATA}/latest.json", "staging": f"{DATA}/staging/latest.json"}
# 代码指针 web.json：latest.json 带 codePointer 标记（开关打开后）时它才是「线上是哪一版代码」的依据，见 ops/code_pointer.py
WEB_POINTERS = {"production": f"{DATA}/web.json", "staging": f"{DATA}/staging/web.json"}
# 两种发布记录：CUT2 起 release-log 上的「Released to kyg-ssr-spike」，之前 edgeone-release 上的「Deploying to edgeone-release」
RELEASE_RE = re.compile(r"(?:Released to kyg-ssr-spike|Deploying to edgeone-release) from @ [\w.-]+/[\w.-]+@([0-9a-f]{40})")
SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")


def git(*args, check=True):
    r = subprocess.run(["git", *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{r.stderr.strip()}")
    return r.stdout.strip() if r.returncode == 0 else None


def fetch_json(url, timeout=20):
    sep = "&" if "?" in url else "?"
    req = urllib.request.Request(f"{url}{sep}cb={int(time.time() * 1000)}", headers={"Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001 —— 读不到就记下原因，计划照出
        return {"_error": str(e)}


def parse_releases(log_text):
    """`git log --format=%H%x09%s` 的输出 → [(release_sha, source_sha)]，新的在前。非发布提交跳过。"""
    out = []
    for line in log_text.splitlines():
        if "\t" not in line:
            continue
        rel, subject = line.split("\t", 1)
        m = RELEASE_RE.search(subject)
        if m:
            out.append((rel.strip(), m.group(1)))
    return out


def merged_releases(release_log_text, legacy_log_text):
    """release-log（CUT2 起，较新）接在前、edgeone-release（切站前，较旧）接在后，新的在前。

    切站后 edgeone-release 不再有新提交，所以直接拼接就是按时间排好的。"""
    return parse_releases(release_log_text) + parse_releases(legacy_log_text)


def previous_source(releases, current):
    """比 current 更早的第一个不同的源 commit；current 为空时取最新那版的前一版。"""
    if not releases:
        return None
    cur = current or releases[0][1]
    seen_cur = False
    for _, src in releases:
        if src == cur:
            seen_cur = True
            continue
        if seen_cur:
            return src
    return None


def release_for(releases, source):
    """源 commit 对应的最新一次发布提交（同一源可能发过多次，取最新那次的产物）。"""
    for rel, src in releases:
        if src == source:
            return rel
    return None


def deploy_supports_promote(sha):
    """目标 commit 的 deploy.yml 是否已有 target／promote 输入（T1 之后）——promote 路要用它自己的 deploy.yml 重建测试站。"""
    y = git("show", f"{sha}:.github/workflows/deploy.yml", check=False)
    return bool(y) and "options: [staging, production]" in y and "promote:" in y


def pipeline_skew(sha, main_ref="origin/main"):
    """目标 commit 与 main 的发布流程差多少（promote 路：测试站按目标自己的 deploy.yml 重建，
    正式站却按 main 的 deploy.yml 构建——两次不是同一套流程）。
    返回 {"e1": 目标是否已有 ops/edgeone-fullstack-build.py, "same_deploy": 目标 deploy.yml 是否与 main 相同（main 读不到时为 None）}。"""
    e1 = git("cat-file", "-e", f"{sha}:ops/edgeone-fullstack-build.py", check=False) is not None
    mine = git("show", f"{sha}:.github/workflows/deploy.yml", check=False)
    main = git("show", f"{main_ref}:.github/workflows/deploy.yml", check=False)
    return {"e1": e1, "same_deploy": None if main is None else mine == main,
            # runner 口径：overview#184 改过自托管，仓库公开期间（09-28 起）又回到托管——只有目标与 main 不一致时才要紧
            "self_hosted": None if mine is None else "self-hosted" in mine,
            "main_self_hosted": None if main is None else "self-hosted" in main}


def has_version_endpoint(sha):
    return git("cat-file", "-e", f"{sha}:edge-functions/api/version.js", check=False) is not None


STAGES = ("start", "promote", "check")
METHODS = ("promote", "release-branch")  # release-branch 只为给出「已停用」的明确报错而保留
# 带 E1（ops/edgeone-fullstack-build.py）的最早一次正式发布；更早的版本回滚不到 kyg-ssr-spike
E1_MIN = "81f71f4"
FAST_PATH = "要更快止血：EdgeOne 控制台 kyg-ssr-spike 回退到上一次部署，或把 www 换绑回旧项目 kaiyuanguji（docs/runbook.md §8）"


def make_plan(target, method, web_commit, releases, pointers, resolve_commit, supports_promote, has_version,
              skew=None, stage="start", web_pointers=None):
    """纯逻辑：给定历史与指针，产出计划（dict）。errors 非空 ＝ 不能执行。

    stage 只对 promote 路有意义（start → promote → check 分段手动触发，见 rollback.yml 顶部注释）。"""
    errors, warnings = [], []
    if method == "release-branch":
        errors.append("release-branch 已停用（CUT2，overview#241）：它恢复的是 edgeone-release，发的是旧项目 kaiyuanguji，"
                      "www 已不在那里。请用 method=promote；" + FAST_PATH)
        stage = "start"
    elif method not in METHODS:
        errors.append(f"method 只能是 promote：{method}")
    if stage not in STAGES:
        errors.append(f"stage 只能是 {'/'.join(STAGES)}：{stage}")
    if stage != "start" and not web_commit:
        # 正式站 promote 完 release-log 就多了一版，「上一次正式发布」随之变了——后续段必须钉死 commit
        errors.append(f"stage={stage} 必须显式给 web_commit（照抄 start 段摘要里的那个 commit）")
    if stage == "promote" and target != "production":
        errors.append("stage=promote 只用于 target=production（测试站演练走 start → check）")
    prod_ptr = pointers.get("production") or {}
    stg_ptr = pointers.get("staging") or {}
    web_pointers = web_pointers or {}
    # 各站「线上是哪一版代码」按 ops/code_pointer.py 的口径读：标了 codePointer 以 web.json 为准，否则以 latest.json.webCommitId 为准
    code_res = {k: code_pointer.resolve(pointers.get(k), web_pointers.get(k)) for k in ("production", "staging")}
    for k, r in code_res.items():
        for n in r["notes"]:
            warnings.append(f"{k}：{n}")
    current_prod = releases[0][1] if releases else (code_res["production"]["commit"] or "")
    current = current_prod if target == "production" else (code_res["staging"]["commit"] or "")

    if web_commit:
        if not SHA_RE.match(web_commit):
            errors.append(f"web_commit 不像 commit：{web_commit}")
            resolved = None
        else:
            resolved = resolve_commit(web_commit)
            if not resolved:
                errors.append(f"仓库里找不到 commit {web_commit}（fetch 完整历史了吗？）")
        chosen_by = "输入指定"
    else:
        resolved = previous_source(releases, current_prod)
        chosen_by = "默认：上一次正式发布"
        if not resolved:
            errors.append("发布历史里找不到上一次正式发布（git fetch origin release-log edgeone-release 了吗？）")

    release_sha = release_for(releases, resolved) if resolved else None
    if resolved and method == "promote" and not supports_promote(resolved):
        errors.append(f"{resolved[:12]} 的 deploy.yml 还没有 target/promote 输入（T1 之前），promote 路重建不了测试站；"
                      "请换一个 T1 之后的 commit，或" + FAST_PATH[len("要更快止血："):])
    if resolved and resolved == current and stage == "start":
        warnings.append(f"目标就是{'正式站' if target == 'production' else '测试站'}当前版本 {resolved[:12]}，回滚等于重发一遍")
    if resolved and method == "promote" and skew:
        k = skew(resolved) or {}
        if k.get("main_self_hosted") is True and k.get("self_hosted") is False:
            warnings.insert(0, f"{resolved[:12]} 的 deploy.yml 还跑 GitHub 托管 runner（main 已改自托管，overview#184）：托管额度用完期间，"
                               "测试站重建会一直排队、永远不开跑。" + FAST_PATH)
        if k.get("e1") is False and target == "production":
            # 正式站 promote 时 build job 检出的是目标 commit（deploy.yml 的 web_ref），调用的是目标自己的
            # ops/edgeone-fullstack-build.py——早于 E1 就没有这个文件，构建必失败、回滚卡住（CUT2 后它是主路，不再 continue-on-error）
            errors.append(f"{resolved[:12]} 早于 E1（没有 ops/edgeone-fullstack-build.py），不能回滚到新项目 kyg-ssr-spike："
                          f"正式站构建检出目标 commit、调用它自己的构建脚本，会直接失败。请选 {E1_MIN} 或更新的版本，"
                          "或走控制台把 www 换绑回旧项目 kaiyuanguji（docs/cutover.md「切站后的发布与回滚」）")
        elif k.get("e1") is False:
            warnings.append(f"{resolved[:12]} 早于 E1（没有 ops/edgeone-fullstack-build.py）：测试站按它自己的 deploy.yml 重建，"
                            "不走白名单构建，重建后测试站 /api/auth/* 会 503；这版也回滚不了正式站")
        if k.get("same_deploy") is False:
            warnings.append(f"{resolved[:12]} 的 deploy.yml 与 main 不同：测试站按目标的旧流程重建并 verify，正式站却按 main 的流程构建，"
                            "测试站验过的不完全等于正式站要发的（根治需 deploy.yml 加 web_ref 输入，见 PR 描述）")
    if resolved and not has_version(resolved):
        warnings.append(f"{resolved[:12]} 早于 /api/version，回滚后该接口会 404；改以代码指针（latest.json 的 webCommitId，标了 codePointer 时是 web.json）核对")
    if target == "production" and resolved and release_sha is None and method == "promote":
        warnings.append(f"{resolved[:12]} 没正式发布过——确认这是你要的版本")
    if method == "promote" and target == "production":
        warnings.append("promote 路：正式站数据会换成测试站此刻重建时的数据（三仓 main HEAD），不是回退前那版")
    for name, p in pointers.items():
        if p.get("_error"):
            warnings.append(f"{name} 数据指针读不到：{p['_error']}")

    steps = []
    short = resolved[:12] if resolved else "?"
    if method != "promote":
        pass  # 已停用的 method：errors 里已说明，不给步骤
    elif stage == "start":
        steps.append(f"打临时 tag 指向 {short}，按该 tag dispatch deploy.yml target=staging（完整 verify），运行建好即删 tag；本段不等它跑完")
        nxt = "stage=promote" if target == "production" else "stage=check"
        steps.append(f"那次重建绿了之后，再跑 Rollback：web_commit={short} {nxt}")
    elif stage == "promote":
        steps.append(f"确认 {short} 最近一次测试站重建是 completed success")
        steps.append("再核一遍测试站指针仍是目标（防 main 刚好有 push 抢先改写），dispatch deploy.yml target=production promote=code+data；本段不等它跑完")
        steps.append(f"它绿了之后，再跑 Rollback：web_commit={short} stage=check")
    else:
        site = "www" if target == "production" else "测试站"
        steps.append(f"核对{site}代码指针 ＝ {short}（latest.json 标了 codePointer 时看 web.json，否则看 latest.json 的 webCommitId）、{site} /api/version（若有），最多等 5 分钟")

    return {
        "target": target,
        "method": method,
        "stage": stage,
        "current_web": current,
        "current_prod_web": current_prod,
        "web_commit": resolved or "",
        "chosen_by": chosen_by,
        "release_sha": release_sha or "",
        "has_version_endpoint": bool(resolved and has_version(resolved)),
        "data_pointer": {k: {f: v.get(f) for f in ("commitId", "productionCommitId", "textCommitId", "webCommitId", "bundleDate", "codePointer")}
                         for k, v in pointers.items()},
        "code_pointer": {k: {"commit": r["commit"], "source": r["source"], "marked": r["marked"], "mismatch": r["mismatch"]}
                         for k, r in code_res.items()},
        "steps": steps,
        "warnings": warnings,
        "errors": errors,
    }


def summary_md(plan, dry_run):
    s = lambda x: (x or "—")[:12]  # noqa: E731
    lines = [
        f"### 回滚计划{'（dry-run，未做任何改动）' if dry_run else ''}",
        "",
        "| 项 | 值 |",
        "|---|---|",
        f"| 目标站 | {plan['target']} |",
        f"| 方式 | {plan['method']} · {plan['stage']} |",
        f"| 当前 web | `{s(plan['current_web'])}` |",
        f"| 退回到 web | `{s(plan['web_commit'])}`（{plan['chosen_by']}） |",
        f"| 对应发布记录 | `{s(plan['release_sha'])}` |",
    ]
    for k, p in plan["data_pointer"].items():
        lines.append(f"| {k} 数据指针 | commit `{s(p.get('commitId'))}` · web `{s(p.get('webCommitId'))}` · {p.get('bundleDate') or '—'} |")
    for k, c in (plan.get("code_pointer") or {}).items():
        lines.append(f"| {k} 代码指针（生效） | `{s(c['commit'])}`（来自 {c['source']}{'，两处不一致' if c['mismatch'] else ''}） |")
    lines += ["", "**将执行：**", ""] + [f"{i}. {t}" for i, t in enumerate(plan["steps"], 1)]
    if plan["warnings"]:
        lines += ["", "**注意：**", ""] + [f"- ⚠️ {w}" for w in plan["warnings"]]
    if plan["errors"]:
        lines += ["", "**不能执行：**", ""] + [f"- ❌ {e}" for e in plan["errors"]]
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--target", choices=["production", "staging"], required=True)
    ap.add_argument("--method", choices=list(METHODS), default="promote")
    ap.add_argument("--stage", choices=list(STAGES), default="start")
    ap.add_argument("--web-commit", default="")
    ap.add_argument("--release-ref", default="origin/release-log", help="CUT2 起的正式发布记录")
    ap.add_argument("--legacy-release-ref", default="origin/edgeone-release", help="切站前的正式发布历史")
    ap.add_argument("--main-ref", default="origin/main", help="与之比较 deploy.yml 的 ref")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    # 分支不存在（例如 CUT2 后还没有过正式发布，release-log 尚未建）时当作空历史
    log = git("log", a.release_ref, "--format=%H%x09%s", "-n", "300", check=False) or ""
    legacy = git("log", a.legacy_release_ref, "--format=%H%x09%s", "-n", "300", check=False) or ""
    releases = merged_releases(log, legacy)
    pointers = {k: fetch_json(u) for k, u in POINTERS.items()}
    web_pointers = {k: fetch_json(u) for k, u in WEB_POINTERS.items()}

    def resolve_commit(c):
        return git("rev-parse", "--verify", "--quiet", f"{c}^{{commit}}", check=False)

    plan = make_plan(a.target, a.method, a.web_commit.strip(), releases, pointers,
                     resolve_commit, deploy_supports_promote, has_version_endpoint,
                     skew=lambda sha: pipeline_skew(sha, a.main_ref), stage=a.stage, web_pointers=web_pointers)
    md = summary_md(plan, a.dry_run)
    print(md)
    print(json.dumps(plan, ensure_ascii=False, indent=1))

    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(md)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            for k in ("web_commit", "release_sha", "current_web", "current_prod_web"):
                f.write(f"{k}={plan[k]}\n")
            f.write(f"has_version_endpoint={'true' if plan['has_version_endpoint'] else 'false'}\n")
    sys.exit(1 if plan["errors"] else 0)


if __name__ == "__main__":
    main()
