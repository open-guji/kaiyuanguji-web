// 造一份迷你 render-docs 产物（手测／冒烟用）：node tests/make-fixture.mjs <out>
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const out = process.argv[2];
mkdirSync(`${out}/docs`, { recursive: true });
const docs = {
  works: [1, 2, 3].map((i) => ({ id: `w${i}`, type: 'work', is_draft: false, title: ['史記', '漢書', '三國志'][i - 1], author: '某', dynasty: '漢', has_text: true, completeness: i, title_chars: i === 3 ? 3 : 2, era_rank: i, title_search: ['史記 史记', '漢書 汉书', '三國志 三国志'][i - 1], title_sort: 'x', description_search: '紀傳體' })),
  books: [{ id: 'b1', type: 'book', title: '史記', edition: '明刻本', holder_search: '國家圖書館', title_search: '史記', has_image: true, completeness: 2, title_chars: 2 }],
  collections: [{ id: 'c1', type: 'collection', title: '四庫全書', title_search: '四庫全書', title_chars: 4 }],
  entities: [{ id: 'e1', type: 'entity', primary_name: '李白', name_search: '李白', pinyin: 'li bai', dynasty: '唐', title_chars: 2, era_rank: 5 }],
  juans: [],
};
const counts = {}, sha256 = {};
for (const [k, v] of Object.entries(docs)) {
  const buf = gzipSync(v.map((d) => JSON.stringify(d)).join('\n') + (v.length ? '\n' : ''));
  writeFileSync(`${out}/docs/${k}.jsonl.gz`, buf);
  counts[k] = v.length; sha256[k] = createHash('sha256').update(buf).digest('hex');
}
writeFileSync(`${out}/manifest.json`, JSON.stringify({ schema: 1, createdAt: new Date().toISOString(), createdAtEpoch: Math.floor(Date.now() / 1000), indexerVersion: 'fixture', renderRunId: 'fx1', commits: { prod: 'a', derived: 'b', text: 'c' }, counts, sha256, editionStats: { total: 3, present: 3, positive: 3 }, partial: false }));
