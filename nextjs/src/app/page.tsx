import LayoutWrapper from '@/components/layout/LayoutWrapper';
import HeroSection from '@/components/home/HeroSection';
import EthosSection from '@/components/home/EthosSection';
import RoadmapSection from '@/components/home/RoadmapSection';

export default function HomePage() {
  return (
    <LayoutWrapper>
      <HeroSection />
      <EthosSection />
      <RoadmapSection />
    </LayoutWrapper>
  );
}
