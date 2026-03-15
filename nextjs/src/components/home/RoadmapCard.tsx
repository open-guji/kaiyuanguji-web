'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useState } from 'react';

interface RoadmapCardProps {
  title: string;
  description: string;
  image: string;
  slug: string;
}

export default function RoadmapCard({ title, description, image, slug }: RoadmapCardProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <Link
      href={`/read/${slug}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="block bg-white rounded-2xl overflow-hidden cursor-pointer
                 transition-all duration-300 ease-in-out"
      style={{
        boxShadow: isHovered
          ? '0 12px 30px rgba(44, 44, 44, 0.1)'
          : '0 8px 15px rgba(44, 44, 44, 0.05)',
      }}
    >
      {/* Image Container */}
      <div className="relative aspect-video overflow-hidden">
        <Image
          src={image}
          alt={title}
          fill
          className="object-cover"
        />
        {/* Gradient Overlay */}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-white/20 to-white" />
      </div>

      {/* Content */}
      <div className="p-5 text-center">
        <h3 className="text-lg font-semibold text-ink mb-2">{title}</h3>
        <p className="text-sm text-secondary leading-relaxed">{description}</p>
      </div>
    </Link>
  );
}
