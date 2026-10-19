/** 读者的客户端随机 id（精校、改字、讨论共用同一个；localStorage 键沿用 kyg-cr-aid） */
const AID_KEY = 'kyg-cr-aid';

function newAid(): string {
    try {
        const u = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : '';
        if (u) return u.replace(/-/g, '');
    } catch { /* 落到下面 */ }
    return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

/** 客户端随机 id：只用来让同一人对同一格的重复提交覆盖旧票；存不了就每次页面加载换一个 */
let memoryAid: string | null = null;
export function getAid(): string {
    try {
        const cur = localStorage.getItem(AID_KEY);
        if (cur && /^[A-Za-z0-9_-]{8,64}$/.test(cur)) return cur;
        const fresh = newAid();
        localStorage.setItem(AID_KEY, fresh);
        return fresh;
    } catch {
        return (memoryAid ??= newAid());
    }
}
