#!/usr/bin/env python3
"""EdgeOne Pages 项目环境变量：列出 / 从一个项目原样抄到另一个项目。

用途（33 卡 §六·1）：把旧正式站项目的环境变量抄到 kyg-ssr-spike，免得人工一项项复制。

安全约定：
- 只打印变量名、所属环境、KV 绑定名，**从不打印值**；
- 值只在内存里从源项目读出、写到目标项目；
- 目标项目上源项目没有的变量保留不动（不删）。

接口与 edgeone CLI 相同：POST https://pages-api.edgeone.ai/v1，Bearer EDGEONE_API_TOKEN。
"""
import json
import os
import sys
import urllib.request

API = "https://pages-api.edgeone.ai/v1"
TOKEN = os.environ["EDGEONE_API_TOKEN"]


def call(action, **params):
    body = json.dumps({"Action": action, **params}).encode()
    req = urllib.request.Request(API, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {TOKEN}",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    resp = (data.get("Data") or {}).get("Response") or data
    if resp.get("Error"):
        err = resp["Error"]
        sys.exit(f"✗ {action}: {err.get('Code')} {err.get('Message')}")
    return resp


def projects():
    out, page = [], 1
    while True:
        r = call("DescribePagesProjects", PageNumber=page, PageSize=50)
        items = r.get("Projects") or []
        out += items
        if len(items) < 50:
            return out
        page += 1


def envs(pid):
    return call("DescribePagesProjectEnvs", ProjectId=pid).get("EnvVars") or []


def kv_bindings(pid):
    try:
        r = call("DescribeProjectKVBindings", ProjectId=pid)
    except SystemExit as e:
        return f"（读不到：{e}）"
    # CLI 里此字段是加密的，这里只报是否存在，不解
    return "有（加密返回，名单请看控制台）" if r.get("EncryptedKVBindings") else "无"


def describe(ps):
    for p in ps:
        pid, name = p.get("ProjectId"), p.get("Name")
        keys = [f"{e['Key']}[{','.join(e.get('Env') or ['all'])}]" for e in envs(pid)]
        print(f"· {name}  ({pid})  类型={p.get('RepoType') or p.get('Type') or '?'}")
        print(f"    环境变量 {len(keys)} 个：{' '.join(sorted(keys)) or '无'}")
        print(f"    KV 绑定：{kv_bindings(pid)}")


def find(ps, name):
    hit = [p for p in ps if p.get("Name") == name]
    if len(hit) != 1:
        sys.exit(f"✗ 项目名 {name!r} 匹配到 {len(hit)} 个；先用 list 看准名字")
    return hit[0]["ProjectId"]


def main():
    mode = os.environ.get("MODE", "list")
    ps = projects()
    if mode == "list":
        describe(ps)
        return
    src, dst = find(ps, os.environ["SOURCE"]), find(ps, os.environ["TARGET"])
    if src == dst:
        sys.exit("✗ 源与目标是同一个项目")
    src_envs = envs(src)
    dst_keys = {(e["Key"], tuple(sorted(e.get("Env") or []))): e.get("Id") for e in envs(dst)}
    for e in src_envs:
        k, scope = e["Key"], tuple(sorted(e.get("Env") or []))
        item = {"Key": k, "Value": str(e.get("Value", ""))}
        if scope:
            item["Env"] = list(scope)
        old = dst_keys.get((k, scope))
        if old:
            item["Id"] = old
        if mode == "sync":
            call("ModifyPagesProjectEnvs", ProjectId=dst, EnvVars=[item])
        print(f"  {'覆盖' if old else '新增'} {k} [{','.join(scope) or 'all'}]"
              + ("" if mode == "sync" else "（dry-run，未写）"))
    kept = sorted({k for (k, _) in dst_keys} - {e["Key"] for e in src_envs})
    print(f"目标上保留未动：{' '.join(kept) or '无'}")
    print("\n—— 写后目标项目 ——")
    describe([p for p in ps if p.get("ProjectId") == dst])


if __name__ == "__main__":
    main()
