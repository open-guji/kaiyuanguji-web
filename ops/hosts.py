"""Python 脚本取域名的入口：读仓库根 config/hosts.json（唯一来源，见 ops/sync-hosts.mjs）。

用法：sys.path 里有 ops/ 时 `import hosts`，然后 hosts.DATA_ORIGIN 等。
"""
import json
import os

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'config', 'hosts.json')
with open(_PATH, encoding='utf-8') as _f:
    HOSTS = json.load(_f)

DATA_ORIGIN = HOSTS['data']
# 旧数据域名：仍可用（同一个 COS 桶），清缓存时两个域名都清
LEGACY_DATA_ORIGIN = HOSTS['legacyData']
API_ORIGIN = HOSTS['api']
LEGACY_API_ORIGIN = HOSTS['legacyApi']
SITE_ORIGIN = HOSTS['site']
SITE_APEX_ORIGIN = HOSTS['siteApex']
STAGING_ORIGIN = HOSTS['staging']
LEGACY_SITE_ORIGIN = HOSTS['legacySite']
LEGACY_APEX_ORIGIN = HOSTS['legacyApex']
OAUTH_ISSUER = HOSTS['oauthIssuer']

DATA_STAGING_ORIGIN = DATA_ORIGIN + '/staging'
