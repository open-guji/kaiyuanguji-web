export interface NetworkProfile {
    name: string;
    label: string;
    downloadBps: number;
    uploadBps: number;
    latencyMs: number;
    /** wait_idle 的默认超时（毫秒）—— 弱网下放宽，避免 30s timeout 人为截断观察 */
    defaultIdleTimeoutMs: number;
}

const KB = 1024;
const MB = 1024 * KB;
const UNLIMITED = -1;

export const PROFILES: NetworkProfile[] = [
    {
        name: 'fast',
        label: '基线（不限速）',
        downloadBps: UNLIMITED,
        uploadBps: UNLIMITED,
        latencyMs: 0,
        defaultIdleTimeoutMs: 30000,
    },
    {
        name: '4g',
        label: '4G（4 Mbps / 70ms）',
        downloadBps: 4 * MB / 8,
        uploadBps: 1 * MB / 8,
        latencyMs: 70,
        defaultIdleTimeoutMs: 45000,
    },
    {
        name: 'slow-4g',
        label: '弱 4G（1 Mbps / 150ms）',
        downloadBps: 1 * MB / 8,
        uploadBps: 750 * KB / 8,
        latencyMs: 150,
        defaultIdleTimeoutMs: 90000,
    },
    {
        name: '3g',
        label: '3G（400 kbps / 400ms）',
        downloadBps: 400 * KB / 8,
        uploadBps: 400 * KB / 8,
        latencyMs: 400,
        defaultIdleTimeoutMs: 180000,
    },
    {
        name: '2g',
        label: '2G（200 kbps / 800ms）',
        downloadBps: 200 * KB / 8,
        uploadBps: 200 * KB / 8,
        latencyMs: 800,
        defaultIdleTimeoutMs: 300000,
    },
];

export function findProfile(name: string): NetworkProfile {
    const p = PROFILES.find((x) => x.name === name);
    if (!p) throw new Error(`Unknown profile: ${name}. Known: ${PROFILES.map((x) => x.name).join(', ')}`);
    return p;
}
