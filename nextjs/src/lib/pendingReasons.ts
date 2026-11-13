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
    // S01 seg_page_unaligned：正文页（非职名等页型）上本格无整理本对位（〓 不算），且同页无对位格 ≥10；或本格是弱证据格（有对位、机器字不同）且本列一致率 <0.5、同页这样的格 ≥10；已钉页直接人审
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
    // S04 seg_defect：人或闸标了切坏格（confirm v=seg_defect，或单上 cls=seg_defect）；史記夹注两行分法不均、按整理本切的格（doubt 码 jiazhu_uneven，cv#1011）也归这里，细分 jiazhu_uneven；整理本这位没字、且格框比本页同类格小得多（边长 <0.6 倍中位数，或长宽比 <0.35；半截字、墨点、框角）的碎片格也归这里，细分 clipped（R02 深挖 11-06）
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
    // H01 hard_pair：本格机器字、整理本字、库首选里出现的字全在 {日 曰 己 已 巳} 内，且至少两个不同；或三者同字而字组是 jys/ry、或库前两名都在组内（A24 Z01 深挖 11-06）
    "hard_pair": {
        "code": "H01",
        "category": "hard_pair",
        "route": "deferred",
        "label": "极难形近",
        "hint": "日曰、己已巳这类刻法几乎不分的字，留到加标点、识专名时一起按文意定",
        "ui": "choose3"
    },
    // Z01 group_abstain：有字组证据、字组没定字，解法一个字都没给（补放、联合判、复核都算；场景写在 detail「组:lift|joint|review」）；字组只是同字异形之争（一个字）也落这里
    "group_abstain": {
        "code": "Z01",
        "category": "group",
        "route": "llm",
        "label": "形近字·没把握",
        "hint": "形近字，几种判法都没给出字，请按前后文选",
        "ui": "pick"
    },
    // Z02 group_conflict：解法给了 ≥2 个不同字（同字异形先折叠，manager#296）；补放、联合判、复核都算。联合判只有一个字（共字组没表态）不算，归 Z07
    "group_conflict": {
        "code": "Z02",
        "category": "group",
        "route": "llm",
        "label": "形近字·判法打架",
        "hint": "几种判法给了不同的字，请按前后文选",
        "ui": "pick"
    },
    // Z03 group_demoted：复核（decision=demote），解法只给一个字、与放行字不同；复核时解法没给字归 Z01、≥2 字归 Z02、整理本是组里另一形（group_flow_ref_dissent）归 Z04
    "group_demoted": {
        "code": "Z03",
        "category": "group",
        "route": "llm",
        "label": "形近字·复核推翻",
        "hint": "复核给了与放行字不同的字",
        "ui": "pick"
    },
    // Z04 group_ref_dissent：解法给了一个字，参校本（现役或坐标对位）是另一个真字：补放 why=ref_dissent/coord_dissent，复核疑问码 group_flow_ref_dissent；参校字是〓的不算，落 R01（A24 Z 类梳理 11-07）
    "group_ref_dissent": {
        "code": "Z04",
        "category": "group",
        "route": "llm",
        "label": "形近字·与参校本不同",
        "hint": "判法给的字和参校本这里的字不一样",
        "ui": "pick"
    },
    // Z05 group_weak：已停用；原为字组其余情况（why=joint/weak）
    "group_weak": {
        "code": "Z05",
        "category": "group",
        "route": "llm",
        "label": "形近字·证据弱（已停用）",
        "hint": "已停用（2026-11-06）：旧数据里还有，不再产出；字形单路没把握并入 Z01，整理本缺位落 R 类",
        "ui": "pick"
    },
    // Z07 group_unconfirmed：解法只给一个字（同字异形折叠后），why=weak（给字的只有不许单独补放的解法，lift_needs）或 why=joint（联合判共字组弃权／没表态）（A24 Z 类梳理 11-07 新增；原落 Z01、Z02）
    "group_unconfirmed": {
        "code": "Z07",
        "category": "group",
        "route": "llm",
        "label": "形近字·差一路确认",
        "hint": "判法给了一个字，但还差另一路（另一种判法或相邻字组）确认，请看这个字对不对",
        "ui": "confirm"
    },
    // N01 near_form_guard：guard=conflict/never_match，或参校字与机器字／库候选前三构成手工形近表（cv NEVER_MATCH_FAMILIES）里的一对；仅疑问码 near_form（家族字碰巧在候选里）不算（A24 N01 深挖 11-06）
    "near_form_guard": {
        "code": "N01",
        "category": "near_form",
        "route": "llm",
        "label": "形近字",
        "hint": "有长得很像的字（十士、西酉…），要结合前后文看",
        "ui": "pick"
    },
    // V01 variant_pair：整理本字与库首选或机器字是异体对（边分型 T1／T2；T3 通假、简繁不算；前五里其它候选不看，A24 V01 深挖 11-06），且不在字组里；或 why 含 ref_lib_variant/variant_indirect/replace_form/channel_off
    "variant_pair": {
        "code": "V01",
        "category": "variant",
        "route": "human",
        "label": "异体字",
        "hint": "两个字是异体，要确认本书刻的是哪个",
        "ui": "pick"
    },
    // V02 variant_form_open：疑问码 form_open：seed_admit 整理本通道放行位，整理本字在用字账（variant_ledger）≥2 写法的同义组里、decide_form 定不了写法（不是形近字组流程产生的）。旧名 group_form_open、码 Z06（2026-11-07 改归异体类，Z06 不再用）
    "variant_form_open": {
        "code": "V02",
        "category": "variant",
        "route": "algo",
        "label": "写法待定",
        "hint": "知道是哪个字，但不确定本书刻的是哪种写法，只在组内写法里挑",
        "ui": "pick"
    },
    // L01 lib_missing：参校字在本书库里 0 例（第一次进库；刻例只算本书版本，借来的不算；A23 11-06）。11-07 起只留这一种：5a 判 diff 但本书库已有这个字（≥3 例）的印糊整字改归 L05／L04，整理本这一位没字的（ref_blank）改归 R02。没接字形库时（不知道刻例数）仍按 5a 判 diff（why 含 lib_miss／「库里没有」）归这里
    "lib_missing": {
        "code": "L01",
        "category": "glyph_lib",
        "route": "human",
        "label": "少见的字",
        "hint": "字形库里还没有这个字，这一格就是它第一次进库，请确认图上是不是参校本的字",
        "ui": "pick"
    },
    // L02 lib_sparse_dissent：参校字在本书库里 1～2 例（只算本书版本；0 例归 L01），不论机器字是否＝参校字（11-07 起 L03 并入；机器字＝参校字的多半是上下文选了形近字、被护栏 ctx_guard_ref 改回）；大模型选中的若是这个少样本字 → 回人审。detail 写「参校字>机器字」
    "lib_sparse_dissent": {
        "code": "L02",
        "category": "glyph_lib",
        "route": "llm",
        "label": "刻例太少",
        "hint": "这个字本书库里只有一两个刻例，库认不准；机器字和参校本可能一致也可能不一致，请看图确认是不是参校本的字",
        "ui": "pick"
    },
    // L03 lib_sparse_agree：已停用；原为参校字本书库 1～2 例且机器字＝参校字（A23 第 6 轮梳理，sheldon 11-07 并入 L02）
    "lib_sparse_agree": {
        "code": "L03",
        "category": "glyph_lib",
        "route": "human",
        "label": "刻例太少（已停用）",
        "hint": "已停用（2026-11-07）：旧数据里还有，不再产出；本书库 1～2 例的格一律落 L02",
        "ui": "pick"
    },
    // L04 lib_unrecognized：兜底——有参校字、机器字（seed_admit char）＝参校字、前面各条都没中（不看刻例数、不看库认不认；不接字形库时 L02 的格也落这里）。另收 5a 判 diff 而本书库已有这个字（≥3 例）、没带乱码闸码的印糊整字（细分 lib_diff，11-07 起，原落 L01）。细分见 pending_reason_detail（reasons.lib_unrecognized_kind）；旧人裁锚点漂移（human_unbound）改归 X01
    "lib_unrecognized": {
        "code": "L04",
        "category": "glyph_lib",
        "route": "algo",
        "label": "库认不出",
        "hint": "库里有这个字，但这一格认不出，多半是印淡或压了框线",
        "ui": "pick"
    },
    // L05 garble_gate：why 含 ctx_garble_shape / shadow_veto / ctx_garble_rare，且整理本这位有字（无对位的糊格落 R02）；11-07 起也收 5a 判 diff（cov<0.85）、本书库已有这个字（≥3 例）而带这些码的格（原落 L01）
    "garble_gate": {
        "code": "L05",
        "category": "glyph_lib",
        "route": "algo",
        "label": "像框线或墨点",
        "hint": "格图印糊，库首位是错字被乱码闸拦下；整理本字多半是对的，先看图",
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
        "hint": "参校本这里写的是〓（没码位的生僻字），请从图上读；若是字形引述（「古文作〓」「說文作〓」等），不硬录常用字，标「图片格」只留图，说明写引述什么字",
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
    // P02 ref_final_diff：不是 P01（没有 replace 标签；align_op 落在 coord），有整理本字、机器字≠整理本字、没被任何通道放行（reasons.py：has_ref and char != ref）
    "ref_final_diff": {
        "code": "P02",
        "category": "mismatch",
        "route": "llm",
        "label": "定字与参校本不同",
        "hint": "文本对位没给这格标签、整理本字只来自坐标对位，机器字和它不同；实测多半是机器字错（cov 低），不是真异文",
        "ui": "pick"
    },
    // X01 ruling_conflict：doubt=src_code_conflict（cv#938）；人裁的机器不能降，单列出卡；另收旧人裁绑丢、旧裁字与本格字对不上（锚点漂移，human_unbound，原落 L04；A23 11-07）
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
    // X03 machine_changed：机器推翻最新人裁（book-text 现文是人裁的字、本轮机器改了）进复审；单上 recheck=true 且 note 以「机器改判」开头、含「推翻人裁」（老单「无人裁」复审格归 recheck）。11-05 起机器改字默认按最新结果进文本，不再复审（cv
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
    // A01 anchor_miss：收尾流水线按格级对照表（旧 ★main→新包）挪锚：旧格挂有标点／专名锚点，对照表里是「删」、IoU 低未配上，或挪过去后 auto_remap --cell-map 校验不过（字变了、专名被拆开）；写在新格（删的写在同页最近的新格）
    "anchor_miss": {
        "code": "A01",
        "category": "anchor",
        "route": "deferred",
        "label": "标点专名要重挂",
        "hint": "这一格的字已定，重跑后它挂的标点或专名没能按格号对照挪过来，点校时重挂",
        "ui": "page"
    },
    // A02 add_del：格级对照表里「新增」的格，或紧邻「删」格的新格，且所在句挂有标点／专名
    "add_del": {
        "code": "A02",
        "category": "anchor",
        "route": "deferred",
        "label": "增删格处重挂",
        "hint": "重跑后这里多了或少了格，附近的标点、专名要按新格重挂",
        "ui": "page"
    },
    // A03 anchor_drift：auto_remap 挪锚后 book-text 格式检查报「其他标点」漂移告警（local_check --dev），且 auto_remap 解释不了（不是对齐后 +1 这类）
    "anchor_drift": {
        "code": "A03",
        "category": "anchor",
        "route": "deferred",
        "label": "标点位置存疑",
        "hint": "标点已按格号挪过来，但位置可能偏了，点校时看一眼",
        "ui": "confirm"
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
    "review": "复审与其他",
    "anchor": "标点专名重挂"
};
/** 旧名 → 新名（2026-11-06 Sheldon 定：P01 ref_replaced→ref_ocr_diff「识别字与参校本对位时就不同」，P02 ref_mismatch→ref_final_diff「对位一致、最后定字与参校本不同」）。读旧单时先换成新名 */
export const PENDING_REASON_RENAMED: Record<string, PendingReason> = {
    "ref_replaced": "ref_ocr_diff",
    "ref_mismatch": "ref_final_diff",
    "group_form_open": "variant_form_open"
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
