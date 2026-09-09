import SectionHeader from './SectionHeader';
import LuaTeXSection from './LuaTeXSection';
import BookIndexSection from './BookIndexSection';
import PlatformSection from './PlatformSection';
import JoinSection from './JoinSection';

export default function RoadmapSection() {
  return (
    <section id="roadmap" className="bg-paper px-6 py-14">
      <div className="mx-auto max-w-7xl">
        <SectionHeader
          title="古籍数字化技术路线图"
          subtitle="从文本提取到智慧化研究的全流程开源技术路径"
          href="/roadmap"
          rule={false}
        />

        <div className="mx-auto max-w-[1100px]">
          <LuaTeXSection />
          <BookIndexSection />
          <PlatformSection />
          <JoinSection />
        </div>
      </div>
    </section>
  );
}
