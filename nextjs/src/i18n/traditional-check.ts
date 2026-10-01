/**
 * 简体模式「残留繁体字」检测（overview#337）。
 *
 * 用法：简体模式下渲染出的正文交给 findTraditionalChars，返回值非空就是有文字没过 i18n / convert。
 * 本文件是 book-index-ui 的 src/i18n/traditional-check.ts 的副本：组件库 0.34 起导出同名函数，升级依赖后改为直接引用。
 * 网站的字典测试（jest）与 e2e/ui/zh-hans.spec.ts 共用这一份。
 *
 * COMMON_TRADITIONAL_CHARS：opencc t2cn 单字会改写的字，取自本包界面文字、样例数据与一份常用字表，
 * 按出现频次排；去掉了在简体里也常规使用的「乾」（乾隆）、「著」（著录）。
 * 专名里的繁体（保护表 PROTECTED_TERMS 里的词等）不算残留，放进 allow 白名单。
 */
/** 与 book-index-ui 的 PROTECTED_TERMS 同步（组件库发版并升级依赖后改为直接引用其 TRADITIONAL_ALLOWLIST） */
const PROTECTED_TERMS: readonly string[] = ['曹霑'];

export const COMMON_TRADITIONAL_CHARS: string = [
    '錄說語詞議樣書記類傳國經補藝紀編後與間條號為開總種無數據冊頁選時題爲詩萬證學續關東圖資歷來讀館論見鈔別進師輯陳覽寫現應從',
    '點兩華實對員長註結闕殘檢閱當會單換體將裡訂處過區釋術頭錢譯識個電動顯問這認質還幾遺雖須專擇係網運權務變發機請風聲輸軍導產',
    '話們車難報讓業設帶辦紙氣麼際聽親場買賣謝費漢庫遷馬叢孫於張義晉閣維曆欽則夢慶齋録舊內陽樓紅淵歸載稱隱遼計評觀禮龜黃興節併',
    '餘齊韓簡霑並樂諸滸屬組篩紹緒劉蘇誤職夾廣蓋敘斷歐寬駰極參試雜魯沒順線貞該測鮮統戰檔衛辭聯臺贊刪聖貫啟瀏譜薈寶約嘗諜謂舉詳',
    '異賦軾復諒構級審標劃彙吳楊暫轉項寧硯蕭儀禪韻掃閉倉麗禎錯監鞏轍繫説筆竄縣聞諡賈僅擊羅宮訓談誌葉視戶細許祿繪鍵絕欄鑑講誕馮',
    '趙習樹饋確賜裝擬規繼製薦畫鉛獨誠遠龍門覺訣隸軒諭繕塊爭鏡裏豐碼備掛堯錦駕鶴遊傷猶鄒瑩綴揚詔託僞頗竊虛莊歲禍爾辯獲篤窮盡跡',
    '萊終穎訛瑣鐫繡廟幀佈躍雙預連狀態軸複懸遞灣箋頌訪層鏈敗達鈞鳳亂奮豈陰婁騎純優獻靈牆隨摺疊驗徑橫瀾蔣壞鈕盤範圍責減籤適側抬',
    '榮聶頃縉讎銓廳軌厲鶚駢醫駝黨鐘諫樞滄軻溫贈鐵徵賴蹟潁閒顗歿駁歟勸諷誼湯詐脫羣尋澤擄顏釀謄鴻離騷傑滯憤執廢懼匱歎毀蠶獄寵闇',
    '陸淺貨輕貧俠賤貴煩競樑鳩採綜謬鳴養堅韋顎呂蘭脈峯鵲兒賞籠階緊綱漁荊嬰慍潛營鎔繞陣塚億負卻塵懷閨擋撐縮領滾輪匯撈貼讚創險團',
    '隊準礙強髒藥鮑顧給緯悅帳巖廬貢亞壇惡諱鎮薊驍愛討彌護揮偉輒擾況較響喪鑰藍',
].join('');

const CHAR_SET = new Set(COMMON_TRADITIONAL_CHARS);

/**
 * 白名单：整词跳过。默认含保护表（如「曹霑」）与繁简切换按钮（有意用目标字体书写）；调用方可再追加专名。
 */
export const TRADITIONAL_ALLOWLIST: readonly string[] = [...PROTECTED_TERMS, '切換為繁體', '漢籍リポジトリ'];

export interface TraditionalHit {
    char: string;
    /** 命中处前后各 8 个字，便于定位 */
    context: string;
}

/** 找出文本里的常见繁体字；allow 里的词先整词剔除 */
export function findTraditionalChars(
    text: string,
    allow: readonly string[] = TRADITIONAL_ALLOWLIST,
): TraditionalHit[] {
    let s = text;
    for (const w of allow) if (w) s = s.split(w).join(' ');
    const hits: TraditionalHit[] = [];
    const chars = Array.from(s);
    chars.forEach((c, i) => {
        if (CHAR_SET.has(c)) hits.push({ char: c, context: chars.slice(Math.max(0, i - 8), i + 9).join('') });
    });
    return hits;
}
