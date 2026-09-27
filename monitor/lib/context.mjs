/** 从仓里读运行所需的「当下事实」：main 要求的 UI 版本、它何时改的、e2e 锚点 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { rangeFloor } from './version.mjs';

export function readRequiredUi(repoRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'nextjs/package.json'), 'utf8'));
    return rangeFloor(pkg.dependencies?.['book-index-ui']);
  } catch {
    return null;
  }
}

/** main 上 nextjs/package.json 最近一次改动的时间（毫秒）；浅克隆没历史时退回 HEAD 时间 */
export function readPkgChangedAt(repoRoot) {
  const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const t = git('log', '-1', '--format=%ct', '--', 'nextjs/package.json') || git('log', '-1', '--format=%ct');
    return t ? Number(t) * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * 锚点沿用 e2e/fixtures/anchors.ts（那边有 perf-ids 契约盯着锚点不烂）。
 * 那是 TS 文件，Node 20 不能直接 import，这里按固定形态抠 id 与书名。
 */
export function readAnchors(repoRoot) {
  const fallback = { entries: { work: 'd59f20aowb9c', entity: 'hixhd2h9bk4b' }, workTitle: '史記' };
  let src;
  try {
    src = readFileSync(join(repoRoot, 'e2e/fixtures/anchors.ts'), 'utf8');
  } catch {
    return fallback;
  }
  return parseAnchors(src) || fallback;
}

export function parseAnchors(src) {
  const block = (name) => {
    const m = new RegExp(`\\n\\s*${name}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`).exec(src);
    return m ? m[1] : '';
  };
  const w = block('work');
  const e = block('entity');
  const id = (s) => /\bid:\s*'([^']+)'/.exec(s)?.[1];
  const title = /\btitle:\s*'([^']+)'/.exec(w)?.[1];
  if (!id(w) || !title) return null;
  const entries = { work: id(w) };
  if (id(e)) entries.entity = id(e);
  return { entries, workTitle: title };
}
