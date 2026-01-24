import LayoutWrapper from '@/components/layout/LayoutWrapper';
import HeroSection from '@/components/home/HeroSection';
import RoadmapSection from '@/components/home/RoadmapSection';
import AssistantSection from '@/components/home/AssistantSection';
import BookIndexSection from '@/components/home/BookIndexSection';
import JoinSection from '@/components/home/JoinSection';

export default function HomePage() {
  return (
    <LayoutWrapper>
      <HeroSection />
      <RoadmapSection />
      <AssistantSection />
      <BookIndexSection />
      <JoinSection />
    </LayoutWrapper>
  );
}
