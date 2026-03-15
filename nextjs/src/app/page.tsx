import LayoutWrapper from '@/components/layout/LayoutWrapper';
import HeroSection from '@/components/home/HeroSection';
import RoadmapSection from '@/components/home/RoadmapSection';
import LuaTeXSection from '@/components/home/LuaTeXSection';
import BookIndexSection from '@/components/home/BookIndexSection';
import PlatformSection from '@/components/home/PlatformSection';
import JoinSection from '@/components/home/JoinSection';

export default function HomePage() {
  return (
    <LayoutWrapper>
      <HeroSection />
      <RoadmapSection />
      <LuaTeXSection />
      <BookIndexSection />
      <PlatformSection />
      <JoinSection />
    </LayoutWrapper>
  );
}
