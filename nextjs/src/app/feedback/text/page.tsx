import { Suspense } from 'react';
import type { Metadata } from 'next';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import TextFixesContent from './TextFixesContent';

// 整册读者意见（GUJI-597）：/feedback/text?book=<书>&vol=<册>。静态页，参数走查询串，清单客户端从 COS 取
export const metadata: Metadata = {
    title: '讀者意見',
    description: '閱讀頁讀者提出的改字、段落與專名意見，按冊彙總。',
    robots: { index: false },
};

export default function TextFixesPage() {
    return (
        <LayoutWrapper>
            <Suspense fallback={null}>
                <TextFixesContent />
            </Suspense>
        </LayoutWrapper>
    );
}
