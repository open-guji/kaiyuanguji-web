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
const BUILD_INFO = null;
// __BUILD_INFO_END__

const DEFAULT_DATA_BASE = 'https://data.kaiyuanguji.com';
// COS 偶尔慢，3 秒会把「慢」报成「缺」；放宽到 8 秒，失败（超时／网络错／非 404 的非 2xx）重试一次（overview#607）
const POINTER_TIMEOUT_MS = 8000;
const POINTER_ATTEMPTS = 2;
// 数据指针里原样转出的字段（都是公开的 commit／时间，latest.json 本身就公开可读）
const POINTER_FIELDS = ['commitId', 'fullCommitId', 'productionCommitId', 'textCommitId', 'commitDate', 'bundleDate', 'webCommitId', 'codePointer'];

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

// 读一个指针 JSON，一次尝试：{ ok, json } | { status } | { error }；status 是服务器明确回的非 2xx（404 就是「确实不存在」）
async function tryReadJson(url, fetchImpl) {
  let timer;
  try {
    const res = await Promise.race([
      fetchImpl(url, { cache: 'no-store' }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), POINTER_TIMEOUT_MS); }),
    ]);
    if (!res || !res.ok) return { status: res ? res.status : 0 };
    return { json: await res.json() };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// 失败重试一次再下结论；404 是明确的「不存在」，不重试
async function readJsonWithRetry(base, name, fetchImpl) {
  let last;
  for (let n = 0; n < POINTER_ATTEMPTS; n += 1) {
    // 每次换一个 cache-buster，别让重试撞上同一个坏缓存
    const url = `${base}/${name}?cb=${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    last = await tryReadJson(url, fetchImpl);
    if (last.json !== undefined || last.status === 404) return last;
  }
  return last;
}

async function readPointer(base, fetchImpl) {
  const r = await readJsonWithRetry(base, 'latest.json', fetchImpl);
  if (r.error) return { error: `latest.json 读取失败：${r.error}` };
  if (r.status !== undefined) return { error: `latest.json HTTP ${r.status || '?'}` };
  const out = {};
  for (const k of POINTER_FIELDS) if (typeof r.json[k] === 'string') out[k] = r.json[k];
  return { pointer: out };
}

// 代码指针 web.json：{ webCommitId, deployedAt, runId }
//   { pointer }  读到了（内容不合格式的当没有，pointer = null）
//   { pointer: null }  确实不存在（404，旧站点、还没写过），不算错误
//   { failed }  读失败（超时／网络错／5xx 等）——和「不存在」分开，别因为 COS 慢就退回 latest.json 比出假的 false
async function readWebPointer(base, fetchImpl) {
  const r = await readJsonWithRetry(base, 'web.json', fetchImpl);
  if (r.error) return { failed: r.error === 'timeout' ? '超时' : r.error };
  if (r.status === 404) return { pointer: null };
  if (r.status !== undefined) return { failed: `HTTP ${r.status || '?'}` };
  const out = {};
  for (const k of ['webCommitId', 'deployedAt', 'runId']) if (typeof r.json[k] === 'string') out[k] = r.json[k];
  return { pointer: /^[0-9a-f]{40}$/.test(out.webCommitId || '') ? out : null };
}

// 「线上是哪一版代码」的读法（overview#470 P1 方案 A）：latest.json 带 codePointer:"web.json" 标记（开关打开后的 data.yml 上传才写）
// ⇒ 以 web.json 为准，web.json 读不到时退回 latest.json；没有标记 ⇒ 仍以 latest.json.webCommitId 为准。
// 与 ops/code_pointer.py、ops/code-pointer.mjs、deploy.yml 的内联段是同一套规则（边缘函数不能 import ops/），
// ops/tests/code-pointer.test.mjs 用同一张用例表对拍，改这里要一起改那几处。
function resolveCodeCommit(latest, web) {
  const sha = (d) => (d && typeof d.webCommitId === 'string' && /^[0-9a-f]{40}$/.test(d.webCommitId) ? d.webCommitId : '');
  const marked = !!latest && latest.codePointer === 'web.json';
  const lc = sha(latest);
  const wc = sha(web);
  if (marked) return wc ? { commit: wc, source: 'web.json' } : { commit: lc, source: 'latest.json（web.json 缺失，退回）' };
  return { commit: lc, source: 'latest.json' };
}

/** 纯函数，便于测试：info = BUILD_INFO，fetchImpl = fetch */
export async function buildVersionBody(info, fetchImpl) {
  const base = dataBaseOf(info);
  // 两个指针同时读，超时不会叠加
  const [{ pointer, error }, { pointer: webPointer, failed: webFailed }] = await Promise.all([readPointer(base, fetchImpl), readWebPointer(base, fetchImpl)]);
  const resolved = resolveCodeCommit(pointer, webPointer);
  // 标了 web.json 为准却读失败（不是 404）：不退回 latest.json 比对，webMatchesPointer 给 null，codeSource 说清楚
  const webReadFailed = !!(pointer && webFailed && pointer.codePointer === 'web.json');
  const committed = pointer && !webReadFailed ? resolved.commit : '';
  const body = {
    web: info && info.web ? info.web : null,
    bimUi: info && info.bimUi ? info.bimUi : null,
    data: pointer && pointer.commitId ? pointer.commitId : null,
    builtAt: info && info.builtAt ? info.builtAt : null,
    target: info && info.target ? info.target : 'unknown',
    dataPointer: pointer || null,
    // 线上代码指针记的是哪一版：latest.json 带 codePointer 标记（数据流程拆出后）时以 web.json 为准，否则以 latest.json 的 webCommitId 为准
    // （见 resolveCodeCommit）；和 web 不一致通常说明只发了代码或只发了数据（promote=data），不一定是故障，但排障时要知道
    webMatchesPointer: committed && info && info.web ? committed === info.web : null,
    // overview#470 P1：代码指针 web.json（部署成功后写）；codeSource 说明上面比对用的是哪个指针
    webPointer: webPointer || null,
    codeSource: pointer ? (webReadFailed ? `web.json 读取失败（${webFailed}）` : resolved.source) : null,
    now: new Date().toISOString(),
  };
  if (!info) body.note = '构建时未写入版本信息（本地／旧产物，或构建不在 CI 里）';
  if (error) body.dataError = error;
  if (webFailed) body.webPointerError = `web.json 读取失败（${webFailed}）`;
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
