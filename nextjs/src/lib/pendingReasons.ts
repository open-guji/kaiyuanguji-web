/**
 * 待审原因 PendingReason（sheldon 2026-11-03 定）：待审单每格的 `pending_reason`。
 * **真源在 guji-manager** `guji_manager/review/pending_reasons.yaml`；本文件由
 * `python -m guji_manager.review.pending_reason --json` 导出 JSON，再用 kaiyuanguji-web `ops/gen_pending_reasons_ts.py <json> <本文件>` 生成；改码表请改 guji-manager、再重新生成，别手改。
 * 每条上面的注释是 yaml 的 `detect`：这个原因在管线哪一步、按什么判出来的。
 * 不认识的值一律按 `unknown` 显示（不确定就写 unknown）。
 * 改过名的旧值（book-text 和已发的旧待审单里还有）经 PENDING_REASON_RENAMED 映射到新名。
 */
export const PENDING_REASON_VERSION = 1;
export const PENDING_REASONS = {
    // S01 seg_page_unaligned：本格无整理本对位，且同页无对位格 ≥10；或本格是弱证据格（有对位、机器字不同）且本列一致率 <0.5、同页这样的格 ≥10；已钉页直接人审
    "seg_page_unaligned": {
        "code": "S01",
        "category": "segmentation",
        "route": "algo",
        "label": "整页对不上",
        "hint": "这一页很多格都对不上参校本，多半是切分或对位错了，请看整页",
        "ui": "page"
    },
    // S02 seg_col_unaligned：本格无对位、整理本有字，且同列无对位格 ≥5
    "seg_col_unaligned": {
        "code": "S02",
        "category": "segmentation",
        "route": "algo",
        "label": "整列对不上",
        "hint": "这一列可能挤格或整列错位",
        "ui": "page"
    },
    // S03 col_width_out_of_band：页打 flag col_width_out_of_band（cv#929 border_detect_gate 1.3，送审不拦）
    "col_width_out_of_band": {
        "code": "S03",
        "category": "segmentation",
        "route": "algo",
        "label": "列宽异常",
        "hint": "本页列宽不均，版框可能量错，先看整页",
        "ui": "page"
    },
    // S04 seg_defect：人或闸标了切坏格（confirm v=seg_defect，或单上 cls=seg_defect）；史記夹注两行分法不均、按整理本切的格（doubt 码 jiazhu_uneven，cv#1011）也归这里，细分 jiazhu_uneven
    "seg_defect": {
        "code": "S04",
        "category": "segmentation",
        "route": "human",
        "label": "切坏格",
        "hint": "这一格切得不完整，机器认不出字；请看书影，把字直接写进框里",
        "ui": "free"
    },
    // D01 occluded_with_ref：成因 D（印章框内＋噪点≥4），整理本有字
    "occluded_with_ref": {
        "code": "D01",
        "category": "occlusion",
        "route": "algo",
        "label": "有遮挡",
        "hint": "被印章或污渍遮住，下面的小字是参校本的字，看图上像不像",
        "ui": "confirm"
    },
    // D02 occluded_no_ref：成因 D，整理本这位空或〓（occ.ref_blank=true）
    "occluded_no_ref": {
        "code": "D02",
        "category": "occlusion",
        "route": "human",
        "label": "有遮挡且参校本缺",
        "hint": "被盖住了，参校本这里也没有字，请尽量从图上读",
        "ui": "free"
    },
    // H01 hard_pair：本格机器字、整理本字、库首选里出现的字全在 {日 曰 己 已 巳} 内，且至少两个不同
    "hard_pair": {
        "code": "H01",
        "category": "hard_pair",
        "route": "deferred",
        "label": "极难形近",
        "hint": "日曰、己已巳这类刻法几乎不分的字，留到加标点、识专名时一起按文意定",
        "ui": "choose3"
    },
    // Z01 group_abstain：有字组证据，solvers 都没给字（不同义组）
    "group_abstain": {
        "code": "Z01",
        "category": "group",
        "route": "llm",
        "label": "形近字·没把握",
        "hint": "形近字，几种判法都没给出字，请按前后文选",
        "ui": "pick"
    },
    // Z02 group_conflict：solvers 给了 ≥2 个不同字，或 why=conflict/joint
    "group_conflict": {
        "code": "Z02",
        "category": "group",
        "route": "llm",
        "label": "形近字·判法打架",
        "hint": "几种判法给了不同的字，请按前后文选",
        "ui": "pick"
    },
    // Z03 group_demoted：字组 decision=demote
    "group_demoted": {
        "code": "Z03",
        "category": "group",
        "route": "llm",
        "label": "形近字·复核推翻",
        "hint": "复核给了与放行字不同的字",
        "ui": "pick"
    },
    // Z04 group_ref_dissent：字组 why=ref_dissent 或 coord_dissent
    "group_ref_dissent": {
        "code": "Z04",
        "category": "group",
        "route": "llm",
        "label": "形近字·与参校本不同",
        "hint": "判法给的字和参校本这里的字不一样",
        "ui": "pick"
    },
    // Z05 group_weak：字组其余情况（why=joint/weak）
    "group_weak": {
        "code": "Z05",
        "category": "group",
        "route": "llm",
        "label": "形近字·证据弱",
        "hint": "判法给了字，但证据不够强",
        "ui": "pick"
    },
    // Z06 group_form_open：字组是同义（写法）组：暂归一、按参校本取字、码位组能解；或 why=form_open
    "group_form_open": {
        "code": "Z06",
        "category": "group",
        "route": "algo",
        "label": "写法待定",
        "hint": "知道是哪个字，但不确定本书刻的是哪种写法，只在组内写法里挑",
        "ui": "pick"
    },
    // N01 near_form_guard：guard=conflict/never_match，或 why 含 near_form/solo_confusable/iron_confusable_ref，且不在字组
    "near_form_guard": {
        "code": "N01",
        "category": "near_form",
        "route": "llm",
        "label": "形近字",
        "hint": "有长得很像的字（十士、西酉…），要结合前后文看",
        "ui": "pick"
    },
    // V01 variant_pair：整理本字与库首选（或前五）是异体对，但不在字组里；或 why 含 ref_lib_variant/variant_indirect/replace_form/channel_off
    "variant_pair": {
        "code": "V01",
        "category": "variant",
        "route": "human",
        "label": "异体字",
        "hint": "两个字是异体，要确认本书刻的是哪个",
        "ui": "pick"
    },
    // L01 lib_missing：整理本字不在字形库（why 含 lib_miss / 「库里没有」）
    "lib_missing": {
        "code": "L01",
        "category": "glyph_lib",
        "route": "human",
        "label": "少见的字",
        "hint": "字形库里还没有这个字，这一格就是它第一次进库，请确认图上是不是参校本的字",
        "ui": "pick"
    },
    // L02 lib_sparse_dissent：整理本字库样本 ≤2，机器字≠整理本；大模型选中的若是这个少样本字 → 回人审
    "lib_sparse_dissent": {
        "code": "L02",
        "category": "glyph_lib",
        "route": "llm",
        "label": "刻例太少·不一致",
        "hint": "库里这个字刻例很少，机器字和参校本不一致",
        "ui": "pick"
    },
    // L03 lib_sparse_agree：整理本字库样本 ≤2，上下文＝整理本
    "lib_sparse_agree": {
        "code": "L03",
        "category": "glyph_lib",
        "route": "human",
        "label": "刻例太少",
        "hint": "这个字库里只有一两个刻例，第一次正式进库，请确认",
        "ui": "pick"
    },
    // L04 lib_unrecognized：库样本 >2，上下文＝整理本，库不认（成因 H）
    "lib_unrecognized": {
        "code": "L04",
        "category": "glyph_lib",
        "route": "algo",
        "label": "库认不出",
        "hint": "库里有这个字，但这一格认不出，多半是印淡或压了框线",
        "ui": "pick"
    },
    // L05 garble_gate：why 含 ctx_garble_shape / shadow_veto / ctx_garble_rare
    "garble_gate": {
        "code": "L05",
        "category": "glyph_lib",
        "route": "algo",
        "label": "像框线或墨点",
        "hint": "字形像框线或墨点，被乱码闸拦下，先看是不是误拦",
        "ui": "free"
    },
    // R03 glyph_pending：整理本这位是私用码，且该码位在私用码表里登记为「已判定待收」（sheldon 11-05）；没登记过的仍记 ref_lacuna。detail 只写永久编号「来源:码位」（如 daizhige:U+E123、siku-qiefen-v2:U+F1001；两套码不一一对应，必须带来源；占位码 U+1001 等以图代字属真图，不进待收字）
    "glyph_pending": {
        "code": "R03",
        "category": "reference",
        "route": "deferred",
        "label": "待收字",
        "hint": "整理本这里是没收进 Unicode 的僻字，暂时找不到合适异体字；已判过，页面先显示字图不留字，将来找到字按码位统一回填（不同于真图／小篆的留图不留字）",
        "ui": "confirm"
    },
    // R01 ref_lacuna：整理本这位是〓或私用码；先走新图源文本层与私用码表（cv#932），再大模型，读不准的人审
    "ref_lacuna": {
        "code": "R01",
        "category": "reference",
        "route": "algo",
        "label": "参校本缺字",
        "hint": "参校本这里写的是〓（没码位的生僻字），请从图上读",
        "ui": "free"
    },
    // R02 ref_gap：整理本这位没字，且不成片（不属 S01/S02）
    "ref_gap": {
        "code": "R02",
        "category": "reference",
        "route": "llm",
        "label": "参校本这里没字",
        "hint": "参校本这一位没有字（漏字或引文异文），请核对",
        "ui": "pick"
    },
    // P01 ref_ocr_diff：Step6 align_ref 文本对位：识别字（字形库首位）与参校本 difflib 对位落在 replace 段（align_op=replace / why=replace_align）
    "ref_ocr_diff": {
        "code": "P01",
        "category": "mismatch",
        "route": "llm",
        "label": "识别字与参校本不同",
        "hint": "机器识别的字和参校本对位时就不同（对位的 replace 段），位置可能差一两格",
        "ui": "pick"
    },
    // P02 ref_final_diff：不是 P01（对位 equal 段或坐标对位），但 seed_admit 最后定的字≠参校字（context_vs_ref / iron_vs_ref / signal_conflict 等）
    "ref_final_diff": {
        "code": "P02",
        "category": "mismatch",
        "route": "llm",
        "label": "定字与参校本不同",
        "hint": "对位时和参校本一致（或按坐标对位），最后定字成了别的字，可能是真异文",
        "ui": "pick"
    },
    // X01 ruling_conflict：doubt=src_code_conflict（cv#938）；人裁的机器不能降，单列出卡
    "ruling_conflict": {
        "code": "X01",
        "category": "review",
        "route": "human",
        "label": "裁定有冲突",
        "hint": "之前的裁定和码表（或新证据）不一致，请看图再定",
        "ui": "pick"
    },
    // X02 vision_flagged：vision_check v=wrong 捞回（doubt vision_flag）
    "vision_flagged": {
        "code": "X02",
        "category": "review",
        "route": "human",
        "label": "看图觉得不对",
        "hint": "模型看图认为放行的字可能不对，请确认",
        "ui": "pick"
    },
    // X03 machine_changed：机器推翻最新人裁（book-text 现文是人裁的字、本轮机器改了）进复审；单上 recheck=true 且 note 为改判。11-05 起机器改字默认按最新结果进文本，不再复审（cv
    "machine_changed": {
        "code": "X03",
        "category": "review",
        "route": "human",
        "label": "机器改了字",
        "hint": "这一轮机器改了人工审定过的字，请确认",
        "ui": "pick"
    },
    // X04 recheck：recheck=true（其余复审原因，含旧裁与新票不一致）
    "recheck": {
        "code": "X04",
        "category": "review",
        "route": "human",
        "label": "复审",
        "hint": "上一单留下的格，请照书影核定",
        "ui": "pick"
    },
    // X99 unknown：以上都不中，或历史数据推不出原因；新数据出现即报警、补规则
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
/** 旧名 → 新名（2026-11-06 Sheldon 定：P01 ref_replaced→ref_ocr_diff「识别字与参校本对位时就不同」，P02 ref_mismatch→ref_final_diff「对位一致、最后定字与参校本不同」）。读旧单时先换成新名 */
export const PENDING_REASON_RENAMED: Record<string, PendingReason> = {
    "ref_replaced": "ref_ocr_diff",
    "ref_mismatch": "ref_final_diff"
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
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
export function parseReason(v: unknown): PendingReason {
    if (typeof v !== 'string') return UNKNOWN_REASON;
    if (has(PENDING_REASONS, v)) return v as PendingReason;
    if (has(PENDING_REASON_RENAMED, v)) return PENDING_REASON_RENAMED[v];
    return UNKNOWN_REASON;
}
export function reasonSpec(v: unknown): ReasonSpec {
    return PENDING_REASONS[parseReason(v)];
}
