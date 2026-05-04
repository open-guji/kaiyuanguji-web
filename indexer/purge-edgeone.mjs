#!/usr/bin/env node
/**
 * EdgeOne CDN cache purge —— 重建索引后调一次，让 5 分钟 TTL 立即失效。
 *
 * 环境变量：
 *   TENCENT_SECRET_ID     EdgeOne 账号的子账号 SecretId（建议只授 EdgeOne purge 权限）
 *   TENCENT_SECRET_KEY    对应 SecretKey
 *   EDGEONE_ZONE_ID       EdgeOne 控制台 → 站点列表 → ID 列
 *   EDGEONE_ENDPOINT      可选，默认 teo.intl.tencentcloudapi.com（国际版）
 *                         国内腾讯云请改为 teo.tencentcloudapi.com
 *   PURGE_HOST            可选，默认 api.kaiyuanguji.com
 *
 * 注意：上海云主机（国内腾讯云账号）和 EdgeOne 国际版（kaiyuanguji.com 加速）
 * 是两个独立账号体系，凭证不通用。purge 用的是 EdgeOne 国际版那套。
 *
 * 退出码：0 成功，1 失败（被 wrapper 用来决定要不要告警）
 */

import tencentcloud from 'tencentcloud-sdk-nodejs-teo';

const { secretId, secretKey, zoneId, host, endpoint } = readEnv();

const client = new tencentcloud.teo.v20220901.Client({
    credential: { secretId, secretKey },
    region: '',
    profile: { httpProfile: { endpoint } },
});

try {
    // purge_host：清整个加速域名 cache。比 purge_url 列出每条 query 简单，
    // 索引刚重建时反正所有热门 query 都得失效。
    const resp = await client.CreatePurgeTask({
        ZoneId: zoneId,
        Type: 'purge_host',
        Targets: [host],
    });
    console.log(`✅ EdgeOne purged ${host} — JobId=${resp.JobId} RequestId=${resp.RequestId}`);
    process.exit(0);
} catch (e) {
    console.error(`❌ purge failed: ${e.message}`);
    if (e.code) console.error(`   code=${e.code}`);
    process.exit(1);
}

function readEnv() {
    const secretId = process.env.TENCENT_SECRET_ID;
    const secretKey = process.env.TENCENT_SECRET_KEY;
    const zoneId = process.env.EDGEONE_ZONE_ID;
    const host = process.env.PURGE_HOST || 'api.kaiyuanguji.com';
    const endpoint = process.env.EDGEONE_ENDPOINT || 'teo.intl.tencentcloudapi.com';
    const missing = [];
    if (!secretId) missing.push('TENCENT_SECRET_ID');
    if (!secretKey) missing.push('TENCENT_SECRET_KEY');
    if (!zoneId) missing.push('EDGEONE_ZONE_ID');
    if (missing.length) {
        console.error(`❌ 缺少环境变量: ${missing.join(', ')}`);
        process.exit(1);
    }
    return { secretId, secretKey, zoneId, host, endpoint };
}
