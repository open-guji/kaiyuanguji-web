import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: '隐私说明',
  description: '开源古籍网站收集哪些访问数据、用来做什么、保留多久，以及如何拒绝。',
  alternates: { canonical: '/privacy' },
};

export default function PrivacyPage() {
  return (
    <LayoutWrapper>
      <article className="mx-auto max-w-3xl px-5 py-12 leading-relaxed text-[var(--color-ink,#222)]">
        <h1 className="mb-6 text-2xl font-bold">隐私说明</h1>
        <p className="mb-4">本站无需注册即可使用。为了解有多少人在用、哪些内容最常被查阅、网站哪里出了问题，我们收集以下有限的数据。</p>

        <h2 className="mb-2 mt-8 text-lg font-semibold">访问统计</h2>
        <p className="mb-4">
          本站使用<strong>百度统计</strong>（主要统计国内访问）与 <strong>Google Analytics</strong>（主要统计海外访问）。
          它们会记录你访问了哪些页面、从哪里进入本站、浏览器与设备类型，并根据 IP 地址推断大致地区（省市或国家），
          同时在浏览器中写入一个随机标识，用于区分新老访客。我们只查看汇总后的数字，
          不做浏览器指纹识别，也不把这些数据与任何个人身份关联。
        </p>

        <h2 className="mb-2 mt-8 text-lg font-semibold">错误报告</h2>
        <p className="mb-4">
          页面出错时，浏览器会把错误信息（出错的页面、错误内容、浏览器型号）发回本站，用于修复问题。
          这类记录附带访问 IP 与大致地区，仅站点管理员可见，计划保留 30 天。
        </p>

        <h2 className="mb-2 mt-8 text-lg font-semibold">用户反馈</h2>
        <p className="mb-4">你主动提交的反馈只保存你填写的内容和所在页面，不记录 IP。</p>

        <h2 className="mb-2 mt-8 text-lg font-semibold">如何拒绝统计</h2>
        <p className="mb-4">
          在浏览器中开启「请勿跟踪」（Do Not Track）或「全局隐私控制」（Global Privacy Control），
          本站将不加载任何访问统计脚本。使用广告拦截插件同样会阻止统计，不影响正常浏览。
        </p>
      </article>
    </LayoutWrapper>
  );
}
