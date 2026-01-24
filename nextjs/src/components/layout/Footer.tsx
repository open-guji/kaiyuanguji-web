export default function Footer() {
  const currentYear = new Date().getFullYear();

  const quickLinks = [
    { label: '项目源码', url: 'https://github.com/open-guji' },
    { label: '问题反馈', url: 'https://wj.qq.com/s2/25492820/38ce/' },
  ];

  return (
    <footer className="bg-black text-white/80">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Desktop Layout */}
        <div className="hidden md:flex justify-evenly py-12 gap-8">
          {/* Column 1: Copyright */}
          <div className="flex flex-col gap-1">
            <p className="text-sm text-white/50">
              © {currentYear} 开源古籍项目组
            </p>
            <p className="text-xs text-white/30">
              Powered by Next.js
            </p>
          </div>

          {/* Column 2: License */}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-bold text-white/80">
              基于 Apache-2.0 协议发布
            </p>
            <p className="text-xs text-white/40">
              推动古籍数字化、校对及开源存储
            </p>
          </div>

          {/* Column 3: Quick Links */}
          <div className="flex flex-col gap-2">
            <p className="text-sm font-bold text-white/80 mb-1">
              快速链接
            </p>
            {quickLinks.map((link) => (
              <a
                key={link.label}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-white/80 underline decoration-white/40
                         hover:text-white hover:decoration-white transition-colors"
              >
                • {link.label}
              </a>
            ))}
          </div>
        </div>

        {/* Mobile Layout */}
        <div className="md:hidden flex flex-col items-center py-8 gap-4">
          {/* Quick Links */}
          <div className="flex gap-6">
            {quickLinks.map((link) => (
              <a
                key={link.label}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-white/80 underline decoration-white/40
                         hover:text-white hover:decoration-white transition-colors"
              >
                {link.label}
              </a>
            ))}
          </div>

          {/* License */}
          <p className="text-sm font-bold text-white/90 text-center">
            基于 Apache-2.0 协议发布
          </p>

          {/* Copyright */}
          <p className="text-xs text-white/40 text-center">
            © {currentYear} 开源古籍项目组 | Powered by Next.js
          </p>
        </div>
      </div>
    </footer>
  );
}
