'use client';

import Link from 'next/link';

export default function HeroSection() {
  const buttons = [
    { label: '路线图', href: '/roadmap' },
    { label: '古籍助手', href: '/assistant' },
    { label: '参与开发', href: '#join' },
  ];

  const handleAnchorClick = (e: React.MouseEvent, href: string) => {
    if (href.startsWith('#')) {
      e.preventDefault();
      const targetId = href.substring(1);
      const targetElement = document.getElementById(targetId);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth' });
      }
    }
  };

  return (
    <section
      className="relative flex items-center justify-center px-6 overflow-hidden
                 h-[500px] md:h-[550px]
                 bg-gradient-to-br from-paper via-border/30 to-paper"
    >
      {/* Background Image */}
      <div
        className="absolute inset-0 opacity-20 bg-center bg-cover"
        style={{ backgroundImage: 'url(/images/hero.png)' }}
      />

      {/* Content */}
      <div className="relative z-10 max-w-[1000px] w-full flex flex-col items-center gap-6 text-center">
        {/* Main Title */}
        <h1 className="text-5xl md:text-7xl font-bold text-ink tracking-[10px]">
          开源古籍
        </h1>

        {/* Subtitle */}
        <h2 className="text-xl md:text-2xl text-ink/90 tracking-[2px] font-medium">
          让科技赋予古籍数字生命
        </h2>

        {/* License Info */}
        <p className="text-sm text-secondary italic tracking-wider">
          全线软件基于 Apache-2.0 协议开源 · 自由使用 · 共享共建
        </p>

        {/* Divider */}
        <div className="w-16 h-0.5 bg-vermilion my-2" />

        {/* Description */}
        <p className="text-base md:text-lg text-ink font-medium leading-loose max-w-2xl px-4">
          通过技术手段推动古籍的数字化、校对及开源存储，构建古籍知识图谱与 AI 模型
        </p>

        {/* Action Buttons */}
        <div className="flex flex-wrap justify-center gap-4 mt-4">
          {buttons.map((button) => (
            <Link
              key={button.label}
              href={button.href}
              onClick={(e) => handleAnchorClick(e, button.href)}
              className="px-10 py-5 text-lg font-semibold text-vermilion tracking-[2px]
                       border-2 border-vermilion rounded-lg
                       hover:bg-vermilion hover:text-white
                       transition-all duration-300"
            >
              {button.label}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
