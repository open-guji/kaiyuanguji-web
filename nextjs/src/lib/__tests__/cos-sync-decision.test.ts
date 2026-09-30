/**
 * @jest-environment node
 *
 * scripts/lib/cos-sync-decision.mjs —— 部署时「COS 数据同步要不要做」的判定（overview#293 第 2 项）。
 * 盯的几件事：
 *  1) 只有三仓 commit、打包脚本指纹、上次完整同步的标记全都对得上才跳过；任何缺失／对不上都照常同步
 *  2) 网站打包脚本改了（数据仓没改）必须触发同步——否则新总目／阅读索引永远上不了线
 *  3) 数据没变时写的 latest.json：以线上为底只改 webCommitId，其它字段不丢
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let m: any;
beforeAll(async () => {
  m = await import('../../../scripts/lib/cos-sync-decision.mjs');
});

const CUR = {
  fullCommitId: 'a'.repeat(40),
  productionCommitId: 'b'.repeat(40),
  textCommitId: 'c'.repeat(40),
  bundleFingerprint: 'f'.repeat(64),
};
const MARKER = { version: 1, ...CUR, webCommitId: 'w', syncedAt: '2026-09-30T00:00:00Z' };
const LATEST = { commitId: 'aaaaaaaaaaaa', cacheKey: 'k1', fullCommitId: CUR.fullCommitId, productionCommitId: CUR.productionCommitId, textCommitId: CUR.textCommitId, webCommitId: 'old' };

describe('decideSync', () => {
  test('全部对得上 → 跳过', () => {
    expect(m.decideSync({ marker: MARKER, latest: LATEST, current: CUR }).skip).toBe(true);
  });

  test.each([
    ['draft 仓变了', { fullCommitId: 'd'.repeat(40) }],
    ['production 仓变了', { productionCommitId: 'd'.repeat(40) }],
    ['book-text 仓变了', { textCommitId: 'd'.repeat(40) }],
    ['打包脚本变了（数据仓没变）', { bundleFingerprint: 'e'.repeat(64) }],
  ])('%s → 照常同步', (_n, patch) => {
    const r = m.decideSync({ marker: MARKER, latest: LATEST, current: { ...CUR, ...patch } });
    expect(r.skip).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  test('没有同步标记（首次，或上次同步没完整成功）→ 照常同步，即使 latest.json 三仓都对得上', () => {
    expect(m.decideSync({ marker: null, latest: LATEST, current: CUR }).skip).toBe(false);
    expect(m.decideSync({ marker: undefined, latest: LATEST, current: CUR }).skip).toBe(false);
    expect(m.decideSync({ marker: 'x', latest: LATEST, current: CUR }).skip).toBe(false);
  });

  test('线上 latest.json 读不到，或它的三仓 commit 与这次不同（标记是旧的）→ 照常同步', () => {
    expect(m.decideSync({ marker: MARKER, latest: null, current: CUR }).skip).toBe(false);
    expect(m.decideSync({ marker: MARKER, latest: { ...LATEST, textCommitId: 'z' }, current: CUR }).skip).toBe(false);
    expect(m.decideSync({ marker: MARKER, latest: { ...LATEST, fullCommitId: undefined }, current: CUR }).skip).toBe(false);
  });

  test('标记里缺字段、这次的输入不全（空串）→ 照常同步', () => {
    const { bundleFingerprint: _f, ...noFp } = MARKER;
    expect(m.decideSync({ marker: noFp, latest: LATEST, current: CUR }).skip).toBe(false);
    for (const k of Object.keys(CUR)) {
      expect(m.decideSync({ marker: MARKER, latest: LATEST, current: { ...CUR, [k]: '' } }).skip).toBe(false);
    }
    expect(m.decideSync({ marker: MARKER, latest: LATEST, current: null }).skip).toBe(false);
  });
});

describe('mergeLatestForUnchangedData', () => {
  test('以线上 latest.json 为底只改 webCommitId，其它字段原样保留', () => {
    const remote = { ...LATEST, bundleDate: '2026-09-30T00:49:34Z', commitDate: 'x', extra: { a: 1 } };
    const next = m.mergeLatestForUnchangedData(remote, { webCommitId: 'newweb' });
    expect(next).toEqual({ ...remote, webCommitId: 'newweb' });
    expect(next).not.toBe(remote); // 不改入参
    expect(remote.webCommitId).toBe('old');
  });

  test('线上的不是对象、缺 commitId／cacheKey、没给 webCommitId → 抛错（调用方退回照常同步）', () => {
    expect(() => m.mergeLatestForUnchangedData(null, { webCommitId: 'w' })).toThrow();
    expect(() => m.mergeLatestForUnchangedData([], { webCommitId: 'w' })).toThrow();
    expect(() => m.mergeLatestForUnchangedData({ commitId: 'x' }, { webCommitId: 'w' })).toThrow();
    expect(() => m.mergeLatestForUnchangedData({ cacheKey: 'x' }, { webCommitId: 'w' })).toThrow();
    expect(() => m.mergeLatestForUnchangedData(LATEST, { webCommitId: '' })).toThrow();
  });
});

describe('buildMarker／key', () => {
  test('标记里有三仓 commit、指纹、web commit、时间', () => {
    const mk = m.buildMarker(CUR, { webCommitId: 'w1', now: new Date('2026-09-30T01:02:03Z') });
    expect(mk).toEqual({ version: 1, ...CUR, webCommitId: 'w1', syncedAt: '2026-09-30T01:02:03.000Z' });
  });
  test('key 带前缀：测试站 staging/，正式站无前缀', () => {
    expect(m.markerKey('staging')).toBe('staging/_deploy/sync-marker.json');
    expect(m.markerKey('')).toBe('_deploy/sync-marker.json');
    expect(m.latestKey('/staging/')).toBe('staging/latest.json');
    expect(m.latestKey('')).toBe('latest.json');
  });
});

describe('computeBundleFingerprint', () => {
  function repo() {
    const root = mkdtempSync(join(tmpdir(), 'kyg-fp-'));
    mkdirSync(join(root, 'nextjs', 'scripts', 'lib'), { recursive: true });
    mkdirSync(join(root, 'nextjs', 'src', 'lib', 'search'), { recursive: true });
    writeFileSync(join(root, 'nextjs', 'scripts', 'bundle-data.mjs'), 'a');
    writeFileSync(join(root, 'nextjs', 'scripts', 'lib', 'x.mjs'), 'b');
    writeFileSync(join(root, 'nextjs', 'src', 'lib', 'search', 'lite.js'), 'c');
    writeFileSync(join(root, 'nextjs', 'package-lock.json'), '{}');
    return root;
  }

  test('同样内容同样指纹；脚本、lite.js、锁文件任一改动都变', () => {
    const r = repo();
    try {
      const base = m.computeBundleFingerprint(r);
      expect(base).toMatch(/^[0-9a-f]{64}$/);
      expect(m.computeBundleFingerprint(r)).toBe(base);
      writeFileSync(join(r, 'nextjs', 'scripts', 'lib', 'x.mjs'), 'b2');
      const f1 = m.computeBundleFingerprint(r);
      expect(f1).not.toBe(base);
      writeFileSync(join(r, 'nextjs', 'src', 'lib', 'search', 'lite.js'), 'c2');
      const f2 = m.computeBundleFingerprint(r);
      expect(f2).not.toBe(f1);
      writeFileSync(join(r, 'nextjs', 'package-lock.json'), '{"a":1}');
      expect(m.computeBundleFingerprint(r)).not.toBe(f2);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test('测试文件不参与（改测试不该触发同步）；新增脚本会变', () => {
    const r = repo();
    try {
      const base = m.computeBundleFingerprint(r);
      writeFileSync(join(r, 'nextjs', 'scripts', 'bundle-data.test.mjs'), 'test');
      writeFileSync(join(r, 'nextjs', 'scripts', 'lib', 'x.test.mjs'), 'test');
      expect(m.computeBundleFingerprint(r)).toBe(base);
      writeFileSync(join(r, 'nextjs', 'scripts', 'new-step.mjs'), 'n');
      expect(m.computeBundleFingerprint(r)).not.toBe(base);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test('真实仓库能算出指纹（脚本目录存在）', () => {
    const fp = m.computeBundleFingerprint(join(__dirname, '..', '..', '..', '..'));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cosConcurrency', () => {
  test('缺省 80；合法正整数生效；非法值退回缺省', () => {
    expect(m.cosConcurrency(80, {})).toBe(80);
    expect(m.cosConcurrency(80, { COS_CONCURRENCY: '24' })).toBe(24);
    for (const bad of ['0', '-3', 'abc', '1.5', '', '9999']) expect(m.cosConcurrency(80, { COS_CONCURRENCY: bad })).toBe(80);
  });
});
