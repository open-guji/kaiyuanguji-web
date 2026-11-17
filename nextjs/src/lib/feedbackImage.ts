/**
 * 反馈截图：浏览器端压缩。最长边缩到 1600px，转 JPEG，逐步降质量直到 ≤ TARGET_BYTES，
 * 返回 data URL（后端只收 jpeg／png／webp 的 data URL，单张解码后 ≤ 700KB）。
 * 转 JPEG 也顺带丢掉了 EXIF（位置等元数据）。
 */
export const IMAGE_MAX_EDGE = 1600;
export const IMAGE_TARGET_BYTES = 450 * 1024;

/** data URL 解码后的字节数（不解码，按长度算） */
export function dataUrlBytes(url: string): number {
    const b64 = url.slice(url.indexOf(',') + 1);
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.floor((b64.length * 3) / 4) - pad;
}

/** 缩放后的尺寸：最长边不超过 max，不放大 */
export function fitSize(w: number, h: number, max = IMAGE_MAX_EDGE): { w: number; h: number } {
    const k = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

export async function compressImage(file: File): Promise<string> {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('unsupported');
    const bmp = await createImageBitmap(file);
    try {
        const { w, h } = fitSize(bmp.width, bmp.height);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas');
        ctx.fillStyle = '#fff'; // PNG 透明底转 JPEG 会变黑
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        let url = '';
        for (const q of [0.85, 0.7, 0.55, 0.4]) {
            url = canvas.toDataURL('image/jpeg', q);
            if (dataUrlBytes(url) <= IMAGE_TARGET_BYTES) return url;
        }
        return url;
    } finally {
        bmp.close();
    }
}
