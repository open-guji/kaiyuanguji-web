#!/usr/bin/env python3
"""定时任务"该跑未跑"检查（overview GUJI-143）。

GitHub 的 schedule 事件常比 cron 晚 3–5 小时，偶尔整晚丢掉（data.yml 自 10-07 起从未触发过）；
workflow 里挂在 schedule 下的告警（如 data.yml 的 36 小时落后告警）定时丢了也一起丢。
这里把检查放到别的触发源（每小时 schedule ＋ 其他 workflow 跑完时的 workflow_run）上：
每条被盯的 workflow 只看"最近一个 cron 时刻之后有没有 schedule run 出现"，
超过宽限（默认 6 小时，覆盖常见的 3–5 小时延迟）还没有就算漏跑。

只读：用 GitHub REST API（令牌取环境变量 GH_TOKEN）读 run 列表，不写任何东西；开／关 issue 由 workflow 的下一步做。
输出：每条一行状态；--out 写 JSON（[{"key":..., "status": "ok|pending|overdue", ...}]）。
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request


def parse_cron(expr):
    """只认每日 'M H * * *'（分 时），别的写法直接报错，免得悄悄判错。"""
    parts = expr.split()
    if len(parts) != 5 or parts[2:] != ['*', '*', '*'] or not (parts[0].isdigit() and parts[1].isdigit()):
        raise ValueError(f'只支持每日 cron "M H * * *"：{expr!r}')
    m, h = int(parts[0]), int(parts[1])
    if not (0 <= m < 60 and 0 <= h < 24):
        raise ValueError(f'cron 时间越界：{expr!r}')
    return m, h


def last_slot(now, minute, hour):
    """now（UTC）之前最近一个 cron 时刻。"""
    slot = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if slot > now:
        slot -= dt.timedelta(days=1)
    return slot


def judge(now, cron, grace_hours, run_times, gaps=()):
    """run_times：该 workflow 的 schedule run 创建时间（datetime，UTC）；gaps：窗口内 run_number 断档（列表可能漏列）。
    返回 (status, slot, latest)。
    overdue 但 run_number 有断档 → suspect（列表漏列过 run，见 GUJI-143 更正：同一查询先后返回 0 条和 7 条），
    不开单；断档一直不补，等到 2 倍宽限再按 overdue 处理，免得漏列掩盖真漏跑。"""
    minute, hour = parse_cron(cron)
    slot = last_slot(now, minute, hour)
    latest = max(run_times) if run_times else None
    if latest is not None and latest >= slot:
        return 'ok', slot, latest
    if now < slot + dt.timedelta(hours=grace_hours):
        return 'pending', slot, latest
    if gaps and now < slot + dt.timedelta(hours=2 * grace_hours):
        return 'suspect', slot, latest
    return 'overdue', slot, latest


def parse_ts(s):
    return dt.datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)


REPO_RE = re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')
WORKFLOW_RE = re.compile(r'^[A-Za-z0-9_.-]+\.ya?ml$')


def _get_json(url, token, what):
    req = urllib.request.Request(
        url, headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
                      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'schedule-watchdog'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except (urllib.error.URLError, OSError, ValueError) as e:
        if isinstance(e, urllib.error.HTTPError):
            e.close()
        raise RuntimeError(f'读 run 列表失败（{what}）：{str(e)[:200]}')


def _check_names(repo, workflow):
    # --watch 来自 workflow 文件里写死的参数；仍只放行 owner/repo 和 xxx.yml 的写法，免得拼进 URL 路径
    if not REPO_RE.match(repo) or not WORKFLOW_RE.match(workflow) or repo.startswith('-') or '..' in repo + workflow:
        raise ValueError(f'repo／workflow 写法不合规：{repo!r} {workflow!r}')


def _api(api):
    return (api or os.environ.get('GITHUB_API_URL') or 'https://api.github.com').rstrip('/')


def fetch_schedule_runs(repo, workflow, token, api=None):
    # 走 REST API（urllib），不起子进程
    _check_names(repo, workflow)
    body = _get_json(f'{_api(api)}/repos/{repo}/actions/workflows/{workflow}/runs?event=schedule&per_page=5',
                     token, f'{repo} {workflow}')
    return [parse_ts(x['created_at']) for x in body.get('workflow_runs', [])]


def fetch_run_gaps(repo, workflow, token, since, api=None):
    """不带 event 过滤取最近 100 个 run，返回 since 之后 run_number 的断档（缺的号）。
    run_number 在同一 workflow 内连续递增，缺号＝列表漏列（或 run 被删，窗口很短时可忽略）。"""
    _check_names(repo, workflow)
    body = _get_json(f'{_api(api)}/repos/{repo}/actions/workflows/{workflow}/runs?per_page=100',
                     token, f'{repo} {workflow} 完整性自检')
    nums = sorted(x['run_number'] for x in body.get('workflow_runs', []) if parse_ts(x['created_at']) >= since)
    if len(nums) < 2:
        return []
    return sorted(set(range(nums[0], nums[-1] + 1)) - set(nums))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--watch', action='append', required=True,
                    help='repo:workflow文件:"M H * * *":宽限小时，如 open-guji/kaiyuanguji-web:data.yml:"10 21 * * *":6')
    ap.add_argument('--out', default='')
    ap.add_argument('--now', default='', help='测试用，UTC，格式 2026-10-14T05:00:00Z')
    args = ap.parse_args(argv)
    token = os.environ.get('GH_TOKEN', '')
    now = parse_ts(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
    results, failed = [], False
    for w in args.watch:
        repo, workflow, cron, grace = w.split(':', 3)
        key = f'{repo}/{workflow}'
        try:
            runs = fetch_schedule_runs(repo, workflow, token)
            minute, hour = parse_cron(cron)
            gaps = fetch_run_gaps(repo, workflow, token, last_slot(now, minute, hour) - dt.timedelta(days=1))
            status, slot, latest = judge(now, cron, float(grace), runs, gaps)
        except Exception as e:  # 读不到就如实报，不当成 ok，也不当成漏跑
            print(f'? {key}：读不到（{e}）')
            results.append({'key': key, 'status': 'unknown', 'error': str(e)})
            failed = True
            continue
        late = latest.strftime('%m-%d %H:%M') if latest else '从未有过'
        extra = f'  run_number 断档 {gaps}（列表可能漏列）' if gaps else ''
        print(f'{status:8} {key}  应在 {slot:%m-%d %H:%M}（UTC）  最近一次 schedule run：{late}{extra}')
        results.append({'key': key, 'workflow': workflow, 'repo': repo, 'cron': cron,
                        'status': status, 'gaps': gaps, 'slot': slot.strftime('%Y-%m-%dT%H:%M:%SZ'),
                        'latest': latest.strftime('%Y-%m-%dT%H:%M:%SZ') if latest else None})
    if args.out:
        with open(args.out, 'w') as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
    return 2 if failed and not any(r['status'] == 'overdue' for r in results) else 0


if __name__ == '__main__':
    sys.exit(main())
