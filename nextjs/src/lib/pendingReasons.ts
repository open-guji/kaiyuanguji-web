/**
 * 待审原因 PendingReason（sheldon 2026-11-03 定）：待审单每格的 `pending_reason`。
 * **真源在 open-guji-cv** `open_guji_cv/review/pending_reasons.yaml`；本文件由
 * `python -m open_guji_cv.review.pending_reason --json` 导出后生成，改码表请改 cv、再重新生成，别手改。
 * 不认识的值一律按 `unknown` 显示（不确定就写 unknown）。
 */
export const PENDING_REASON_VERSION = 1;
export const PENDING_REASONS = {
    "seg_page_unaligned": {
        "code": "S01",
        "category": "segmentation",
        "route": "algo",
        "label": "整页对不上",
        "hint": "这一页很多格都对不上参校本，多半是切分或对位错了，请看整页",
        "ui": "page"
    },
    "seg_col_unaligned": {
        "code": "S02",
        "category": "segmentation",
        "route": "algo",
        "label": "整列对不上",
        "hint": "这一列可能挤格或整列错位",
        "ui": "page"
    },
    "col_width_out_of_band": {
        "code": "S03",
        "category": "segmentation",
        "route": "algo",
        "label": "列宽异常",
        "hint": "本页列宽不均，版框可能量错，先看整页",
        "ui": "page"
    },
    "seg_defect": {
        "code": "S04",
        "category": "segmentation",
        "route": "human",
        "label": "切坏格",
        "hint": "这一格切得不完整，机器认不出字；请看书影，把字直接写进框里",
        "ui": "free"
    },
    "occluded_with_ref": {
        "code": "D01",
        "category": "occlusion",
        "route": "algo",
        "label": "有遮挡",
        "hint": "被印章或污渍遮住，下面的小字是参校本的字，看图上像不像",
        "ui": "confirm"
    },
    "occluded_no_ref": {
        "code": "D02",
        "category": "occlusion",
        "route": "human",
        "label": "有遮挡且参校本缺",
        "hint": "被盖住了，参校本这里也没有字，请尽量从图上读",
        "ui": "free"
    },
    "hard_pair": {
        "code": "H01",
        "category": "hard_pair",
        "route": "deferred",
        "label": "极难形近",
        "hint": "日曰、己已巳这类刻法几乎不分的字，留到加标点、识专名时一起按文意定",
        "ui": "choose3"
    },
    "group_abstain": {
        "code": "Z01",
        "category": "group",
        "route": "llm",
        "label": "形近字·没把握",
        "hint": "形近字，几种判法都没给出字，请按前后文选",
        "ui": "pick"
    },
    "group_conflict": {
        "code": "Z02",
        "category": "group",
        "route": "llm",
        "label": "形近字·判法打架",
        "hint": "几种判法给了不同的字，请按前后文选",
        "ui": "pick"
    },
    "group_demoted": {
        "code": "Z03",
        "category": "group",
        "route": "llm",
        "label": "形近字·复核推翻",
        "hint": "复核给了与放行字不同的字",
        "ui": "pick"
    },
    "group_ref_dissent": {
        "code": "Z04",
        "category": "group",
        "route": "llm",
        "label": "形近字·与参校本不同",
        "hint": "判法给的字和参校本这里的字不一样",
        "ui": "pick"
    },
    "group_weak": {
        "code": "Z05",
        "category": "group",
        "route": "llm",
        "label": "形近字·证据弱",
        "hint": "判法给了字，但证据不够强",
        "ui": "pick"
    },
    "group_form_open": {
        "code": "Z06",
        "category": "group",
        "route": "algo",
        "label": "写法待定",
        "hint": "知道是哪个字，但不确定本书刻的是哪种写法，只在组内写法里挑",
        "ui": "pick"
    },
    "near_form_guard": {
        "code": "N01",
        "category": "near_form",
        "route": "llm",
        "label": "形近字",
        "hint": "有长得很像的字（十士、西酉…），要结合前后文看",
        "ui": "pick"
    },
    "variant_pair": {
        "code": "V01",
        "category": "variant",
        "route": "human",
        "label": "异体字",
        "hint": "两个字是异体，要确认本书刻的是哪个",
        "ui": "pick"
    },
    "lib_missing": {
        "code": "L01",
        "category": "glyph_lib",
        "route": "human",
        "label": "少见的字",
        "hint": "字形库里还没有这个字，这一格就是它第一次进库，请确认图上是不是参校本的字",
        "ui": "pick"
    },
    "lib_sparse_dissent": {
        "code": "L02",
        "category": "glyph_lib",
        "route": "llm",
        "label": "刻例太少·不一致",
        "hint": "库里这个字刻例很少，机器字和参校本不一致",
        "ui": "pick"
    },
    "lib_sparse_agree": {
        "code": "L03",
        "category": "glyph_lib",
        "route": "human",
        "label": "刻例太少",
        "hint": "这个字库里只有一两个刻例，第一次正式进库，请确认",
        "ui": "pick"
    },
    "lib_unrecognized": {
        "code": "L04",
        "category": "glyph_lib",
        "route": "algo",
        "label": "库认不出",
        "hint": "库里有这个字，但这一格认不出，多半是印淡或压了框线",
        "ui": "pick"
    },
    "garble_gate": {
        "code": "L05",
        "category": "glyph_lib",
        "route": "algo",
        "label": "像框线或墨点",
        "hint": "字形像框线或墨点，被乱码闸拦下，先看是不是误拦",
        "ui": "free"
    },
    "ref_lacuna": {
        "code": "R01",
        "category": "reference",
        "route": "algo",
        "label": "参校本缺字",
        "hint": "参校本这里写的是〓（没码位的生僻字），请从图上读",
        "ui": "free"
    },
    "ref_gap": {
        "code": "R02",
        "category": "reference",
        "route": "llm",
        "label": "参校本这里没字",
        "hint": "参校本这一位没有字（漏字或引文异文），请核对",
        "ui": "pick"
    },
    "ref_replaced": {
        "code": "P01",
        "category": "mismatch",
        "route": "llm",
        "label": "参校本改过字",
        "hint": "参校本这一段改过字，位置可能差一两格",
        "ui": "pick"
    },
    "ref_mismatch": {
        "code": "P02",
        "category": "mismatch",
        "route": "llm",
        "label": "和参校本不一致",
        "hint": "机器的判断和参校本这里的字不一样，可能是真异文",
        "ui": "pick"
    },
    "ruling_conflict": {
        "code": "X01",
        "category": "review",
        "route": "human",
        "label": "裁定有冲突",
        "hint": "之前的裁定和码表（或新证据）不一致，请看图再定",
        "ui": "pick"
    },
    "vision_flagged": {
        "code": "X02",
        "category": "review",
        "route": "human",
        "label": "看图觉得不对",
        "hint": "模型看图认为放行的字可能不对，请确认",
        "ui": "pick"
    },
    "machine_changed": {
        "code": "X03",
        "category": "review",
        "route": "human",
        "label": "机器改了字",
        "hint": "这一轮机器把这个字改了（和已发布的文本不同），请确认",
        "ui": "pick"
    },
    "recheck": {
        "code": "X04",
        "category": "review",
        "route": "human",
        "label": "复审",
        "hint": "上一单留下的格，请照书影核定",
        "ui": "pick"
    },
    "unknown": {
        "code": "X99",
        "category": "review",
        "route": "human",
        "label": "原因不明",
        "hint": "系统没能确定这一格为什么待审，请照书影核定",
        "ui": "pick"
    }
} as const;
export const REASON_CATEGORIES: Record<string, string> = {
    "segmentation": "切分位置",
    "occlusion": "遮挡",
    "group": "形近字组",
    "hard_pair": "极难形近",
    "near_form": "形近护栏",
    "variant": "异体",
    "glyph_lib": "字形库",
    "reference": "参校本缺位",
    "mismatch": "与参校本不一致",
    "review": "复审与其他"
};
export const REASON_ROUTES: Record<string, string> = {
    "human": "一定人审",
    "llm": "大模型统一过一遍（只收 high，其余回人审）",
    "algo": "先改算法，改完剩下的并入 llm",
    "deferred": "留到标点、专名阶段"
};
export type PendingReason = keyof typeof PENDING_REASONS;
export type ReasonSpec = (typeof PENDING_REASONS)[PendingReason];
export const UNKNOWN_REASON: PendingReason = 'unknown';
export function parseReason(v: unknown): PendingReason {
    return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PENDING_REASONS, v) ? (v as PendingReason) : UNKNOWN_REASON;
}
export function reasonSpec(v: unknown): ReasonSpec {
    return PENDING_REASONS[parseReason(v)];
}
