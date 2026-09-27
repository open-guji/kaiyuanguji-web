/** 样本存成 JSONL（一行一条），追加写、按时间裁剪。放在 Actions cache 里跨轮累积。 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJsonl(path) {
  if (!path || !existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半行（写到一半被杀）丢掉 */ }
  }
  return out;
}

/** 追加并只保留最近 keepHours 小时 */
export function appendJsonl(path, rows, { now = Date.now(), keepHours = 72 } = {}) {
  const cutoff = now - keepHours * 3600000;
  const kept = [...readJsonl(path), ...rows].filter((r) => Date.parse(r.t) >= cutoff);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
  return kept.length;
}
