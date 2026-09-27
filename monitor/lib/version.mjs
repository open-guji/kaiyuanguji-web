/** 语义版本比较（只看 x.y.z 数字段）：a<b → 负，a=b → 0，a>b → 正 */
export function cmpVersion(a, b) {
  const pa = String(a).match(/\d+/g)?.map(Number) ?? [];
  const pb = String(b).match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** package.json 区间的下界："^0.9.7" → "0.9.7" */
export function rangeFloor(range) {
  const m = String(range ?? '').match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** 从 HTML 读 <meta name="bim-ui-version" content="x"> */
export function uiVersionFromHtml(html) {
  const m = String(html).match(/<meta[^>]*name="bim-ui-version"[^>]*content="([^"]*)"/)
    || String(html).match(/<meta[^>]*content="([^"]*)"[^>]*name="bim-ui-version"/);
  return m ? (m[1] || null) : null;
}
