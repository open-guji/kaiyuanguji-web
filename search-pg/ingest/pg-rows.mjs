/**
 * Meili 文档（render-docs 产物）→ search_doc 一行。词元在这里算好（单字＋相邻二字，拉丁／数字取整词），库里不分词。
 * 字段来源与 Meili SETTINGS.searchableAttributes 对齐：
 *   title 词元＝title_search（人物为 name_search）＋ title_sort／pinyin；
 *   name 词元＝书名＋作者＋别名＋版本＋馆藏＋人物名＋拼音；desc 词元＝description_search＋indexed_by_search。
 */
export const KIND_BY_INDEX = { works: 'work', books: 'book', collections: 'collection', entities: 'entity' };
export const PG_INDEXES = Object.keys(KIND_BY_INDEX);

const RUN = /[㐀-鿿豈-﫿\u{20000}-\u{3FFFF}]+|[0-9a-z]+/gu;
const ASCII = /^[0-9a-z]+$/;

/** 文本 → 词元数组（去重）：中文段每个字＋相邻二字；拉丁／数字整段 */
export function grams(text) {
    const out = new Set();
    for (const m of String(text || '').toLowerCase().matchAll(RUN)) {
        const s = m[0];
        if (ASCII.test(s)) { out.add(s); continue; }
        const cs = Array.from(s);
        for (let i = 0; i < cs.length; i++) {
            out.add(cs[i]);
            if (i + 1 < cs.length) out.add(cs[i] + cs[i + 1]);
        }
    }
    return [...out];
}

/** 书名开头词元：title_search 里每个词（繁／简各一个）取前 1 字和前 2 字，加「^」前缀。
 *  search_one 用它让「书名以查询词开头」的排前面（Meili 的 attribute 规则看词的位置）。 */
export function headTokens(text) {
    const out = new Set();
    for (const w of String(text || '').toLowerCase().split(/\s+/)) {
        const m = w.match(/^[㐀-鿿豈-﫿\u{20000}-\u{3FFFF}]+/u);
        if (!m) continue;
        const cs = Array.from(m[0]);
        out.add(`^${cs[0]}`);
        if (cs.length > 1) out.add(`^${cs[0]}${cs[1]}`);
    }
    return [...out];
}

const NAME_FIELDS = ['title_search', 'author_search', 'aliases_search', 'edition_search', 'holder_search', 'name_search', 'pinyin'];
const DESC_FIELDS = ['description_search', 'indexed_by_search'];
const PAYLOAD_FIELDS = ['edition', 'era', 'sort_year', 'role', 'juan_count', 'birth_year', 'death_year', 'cbdb_id', 'holder'];
const joinFields = (d, fields) => fields.map((k) => d[k] || '').join(' ');
const nz = (v) => (v === undefined || v === '' ? null : v);

export function docToRow(index, d) {
    const kind = KIND_BY_INDEX[index];
    if (!kind) throw new Error(`不支持的索引：${index}`);
    if (!d || !d.id) throw new Error('文档缺 id');
    const title = d.title || d.primary_name || '';
    const payload = {};
    for (const k of PAYLOAD_FIELDS) if (d[k] !== undefined && d[k] !== null && d[k] !== '') payload[k] = d[k];
    return {
        kind,
        id: String(d.id),
        title,
        author: nz(d.author),
        dynasty: nz(d.dynasty),
        classification: nz(d.classification),
        loss_status: nz(d.loss_status),
        subtype: nz(d.subtype),
        has_text: typeof d.has_text === 'boolean' ? d.has_text : null,
        has_image: typeof d.has_image === 'boolean' ? d.has_image : null,
        has_collated: typeof d.has_collated === 'boolean' ? d.has_collated : null,
        completeness: Number.isFinite(d.completeness) ? d.completeness : 0,
        title_chars: Number.isFinite(d.title_chars) ? d.title_chars : Array.from(title).length,
        era_rank: Number.isFinite(d.era_rank) ? d.era_rank : 9999,
        title_sort: nz(d.title_sort),
        office_ids: (d.office_ids || []).map(String),
        title_tok: [...grams(`${d.title_search || d.name_search || ''} ${d.title_sort || d.pinyin || ''}`), ...headTokens(d.title_search || d.name_search || title)],
        name_tok: grams(joinFields(d, NAME_FIELDS)),
        desc_tok: grams(joinFields(d, DESC_FIELDS)),
        descr: Array.from(d.description_search || '').slice(0, 1000).join(''),
        payload,
    };
}
