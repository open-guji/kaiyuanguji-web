/**
 * e2e 的繁体字检测副本（e2e/fixtures/traditional-check.ts）必须与组件库导出的一致（overview#337）。
 * 线上验收只装 e2e 的依赖，引不到组件库，只好留一份副本；组件库改了字表或白名单，这里会红，照着同步副本。
 */
import { COMMON_TRADITIONAL_CHARS, TRADITIONAL_ALLOWLIST, findTraditionalChars } from 'book-index-ui';
import * as copy from '../../../../e2e/fixtures/traditional-check';

describe('e2e 繁体字检测副本与 book-index-ui 一致', () => {
    it('字表一致', () => {
        expect(copy.COMMON_TRADITIONAL_CHARS).toBe(COMMON_TRADITIONAL_CHARS);
    });
    it('白名单一致', () => {
        expect([...copy.TRADITIONAL_ALLOWLIST]).toEqual([...TRADITIONAL_ALLOWLIST]);
    });
    it('检测结果一致', () => {
        const s = '古籍文本与輯佚，曹霑撰，切換為繁體';
        expect(copy.findTraditionalChars(s)).toEqual(findTraditionalChars(s));
    });
});
