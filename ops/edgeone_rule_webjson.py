#!/usr/bin/env python3
"""11-27：把 /web.json、/staging/web.json 加进数据站点（EDGEONE_DATA_ZONE_ID）规则「latest-json 不缓存」的路径条件。
默认只读（打印改前改后的条件）；--apply 才调 ModifyL7AccRule，并读回核对。只动这一条规则的 Condition，动作原样不改。
需要 TENCENT_SECRET_ID／TENCENT_SECRET_KEY、EDGEONE_DATA_ZONE_ID。"""
import json, os, sys
from tencentcloud.common import credential
from tencentcloud.teo.v20220901 import models, teo_client

RULE_NAME = 'latest-json 不缓存'
ADD = ['/web.json', '/staging/web.json']
cred = credential.Credential(os.environ['TENCENT_SECRET_ID'], os.environ['TENCENT_SECRET_KEY'])
client = teo_client.TeoClient(cred, '')
zone = os.environ['EDGEONE_DATA_ZONE_ID']


def call(name, **params):
    req = getattr(models, name + 'Request')()
    req.from_json_string(json.dumps(params))
    return json.loads(getattr(client, name)(req).to_json_string())


def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if v is not None}
    if isinstance(o, list):
        return [strip(v) for v in o]
    return o


def find():
    r = call('DescribeL7AccRules', ZoneId=zone, Limit=100, Offset=0)
    hit = [x for x in r.get('Rules', []) if x.get('RuleName') == RULE_NAME]
    if len(hit) != 1:
        sys.exit(f'✗ 规则 {RULE_NAME!r} 匹配到 {len(hit)} 条')
    return hit[0]


rule = find()
br = rule['Branches']
cond = br[0]['Condition']
print('改前条件：', cond)
if all(a in cond for a in ADD):
    print('已包含，无需改'); sys.exit(0)
if not cond.rstrip().endswith(']'):
    sys.exit('✗ 条件格式不是预期的「… in [..]」，不自动改')
new_cond = cond.rstrip()[:-1] + ''.join(f", '{a}'" for a in ADD) + ']'
print('改后条件：', new_cond)
if '--apply' not in sys.argv:
    print('（dry-run，未写）'); sys.exit(0)
branches = strip(br)
branches[0]['Condition'] = new_cond
body = {'RuleName': rule['RuleName'], 'Status': rule['Status'], 'Branches': branches}
if rule.get('Description'):
    body['Description'] = rule['Description']
call('ModifyL7AccRule', ZoneId=zone, RuleId=rule['RuleId'], Rule=body)
after = find()
print('读回条件：', after['Branches'][0]['Condition'])
print('读回动作：', json.dumps([a.get('Name') for a in after['Branches'][0]['Actions']], ensure_ascii=False), '规则状态：', after.get('Status'))
ok = all(a in after['Branches'][0]['Condition'] for a in ADD)
print('✅ 已生效' if ok else '❌ 读回没有包含新路径')
sys.exit(0 if ok else 1)
