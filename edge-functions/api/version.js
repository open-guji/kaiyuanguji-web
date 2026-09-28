// GET /api/version —— 线上现在是哪一版（DBG，内测排障用）
//
//   { web, bimUi, data, builtAt, target, ... }
//   web     网站代码 commit（构建时写入）
//   bimUi   打进产物的 book-index-ui 版本（构建时写入）
//   data    数据指针 latest.json 的 commitId（运行时读 COS，staging 读 staging/ 前缀）
//   builtAt 构建时间（构建时写入）
//   target  production（www）/ staging / ssr-test（构建时写入）
//
// 构建信息不读运行时环境变量：正式站的边缘函数拿不到 CI 变量，全栈站的 env 又只有白名单。
// 改由 next build（CI 里）把一行 `const BUILD_INFO = {...}` 写进下面的标记区——
// 见 nextjs/scripts/lib/build-info.cjs。仓库里的这份永远是 null（本地未构建 = 没有版本信息）。
//
// 公开、无鉴权：只回版本号与公开 CDN 上的数据指针，不含任何密钥、内网地址、访客信息。
// no-store：排障时要的是「此刻」的版本，绝不能被 CDN 缓存成旧答案。

// __BUILD_INFO_START__
const BUILD_INFO = {"web":"81f71f433ccb2d62bdaf8d6914db5e5bbe7f05b2","bimUi":"0.9.8","builtAt":"2026-09-28T11:12:05.863Z","target":"production","dataBase":"https://data.kaiyuanguji.com"};
// __BUILD_INFO_END__

const DEFAULT_DATA_BASE = 'https://data.kaiyuanguji.com';
const POINTER_TIMEOUT_MS = 3000;
// 数据指针里原样转出的字段（都是公开的 commit／时间，latest.json 本身就公开可读）
const POINTER_FIELDS = ['commitId', 'fullCommitId', 'productionCommitId', 'textCommitId', 'commitDate', 'bundleDate', 'webCommitId'];

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

function dataBaseOf(info) {
  const b = info && typeof info.dataBase === 'string' ? info.dataBase : '';
  // 只认自家数据域名（根或 staging/），别的一律回默认——这个地址会被服务端 fetch
  return /^https:\/\/data\.kaiyuanguji\.com(\/staging)?$/.test(b) ? b : DEFAULT_DATA_BASE;
}

async function readPointer(base, fetchImpl) {
  const url = `${base}/latest.json?cb=${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  let timer;
  try {
    const res = await Promise.race([
      fetchImpl(url, { cache: 'no-store' }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), POINTER_TIMEOUT_MS); }),
    ]);
    if (!res || !res.ok) return { error: `latest.json HTTP ${res ? res.status : '?'}` };
    const j = await res.json();
    const out = {};
    for (const k of POINTER_FIELDS) if (typeof j[k] === 'string') out[k] = j[k];
    return { pointer: out };
  } catch (e) {
    return { error: `latest.json 读取失败：${e && e.message ? e.message : e}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 纯函数，便于测试：info = BUILD_INFO，fetchImpl = fetch */
export async function buildVersionBody(info, fetchImpl) {
  const base = dataBaseOf(info);
  const { pointer, error } = await readPointer(base, fetchImpl);
  const body = {
    web: info && info.web ? info.web : null,
    bimUi: info && info.bimUi ? info.bimUi : null,
    data: pointer && pointer.commitId ? pointer.commitId : null,
    builtAt: info && info.builtAt ? info.builtAt : null,
    target: info && info.target ? info.target : 'unknown',
    dataPointer: pointer || null,
    // 数据指针里记的是「上次发布数据时用的网站代码」；和 web 不一致通常说明
    // 只发了代码或只发了数据（promote=data），不一定是故障，但排障时要知道
    webMatchesPointer: pointer && pointer.webCommitId && info && info.web ? pointer.webCommitId === info.web : null,
    now: new Date().toISOString(),
  };
  if (!info) body.note = '构建时未写入版本信息（本地／旧产物，或构建不在 CI 里）';
  if (error) body.dataError = error;
  return body;
}

export async function onRequestGet() {
  const body = await buildVersionBody(BUILD_INFO, fetch);
  return new Response(JSON.stringify(body), { status: 200, headers: HEADERS });
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { ...HEADERS, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' },
  });
}
