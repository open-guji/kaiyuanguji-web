'use client';

import { useSource } from './SourceContext';
import { DataSource } from '@/lib/constants';

export default function SourceToggle() {
    const { source, setSource, isAutoDetected } = useSource();

    // 暂时隐藏：总是默认海外
    return null;

    const toggleSource = () => {
        setSource(source === 'github' ? 'gitee' : 'github');
    };

    return (
        <div className="flex items-center gap-2">
            <div className="flex bg-paper/80 border border-border/60 rounded-full p-1 shadow-sm">
                <button
                    onClick={() => setSource('github')}
                    className={`
            px-3 py-1 text-xs rounded-full transition-all duration-300
            ${source === 'github'
                            ? 'bg-ink text-white shadow-inner'
                            : 'text-secondary hover:text-ink'
                        }
          `}
                >
                    海外
                </button>
                <button
                    onClick={() => setSource('gitee')}
                    className={`
            px-3 py-1 text-xs rounded-full transition-all duration-300
            ${source === 'gitee'
                            ? 'bg-ink text-white shadow-inner'
                            : 'text-secondary hover:text-ink'
                        }
          `}
                >
                    国内
                </button>
            </div>

            {isAutoDetected && source === 'gitee' && (
                <span className="text-[10px] text-vermilion/70 animate-pulse bg-vermilion/5 px-2 py-0.5 rounded-full border border-vermilion/20 hidden md:inline">
                    已自动切换
                </span>
            )}
        </div>
    );
}
