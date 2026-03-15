'use client';

import { useState } from 'react';

interface CopyButtonProps {
    text: string;
    label?: string;
}

export default function CopyButton({ text, label }: CopyButtonProps) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <div className="flex items-center gap-2 text-xs">
            {label && <span className="text-secondary/60">{label}:</span>}
            <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-2 py-1 rounded bg-paper/50 hover:bg-border/30 
                   text-secondary hover:text-vermilion transition-all duration-200 
                   border border-border/40 group focus:ring-2 focus:ring-vermilion/20 focus:outline-none"
                title={`复制 ${label || '内容'}`}
                aria-label={copied ? '已复制' : `复制 ${label ? `${label}: ` : ''}${text}`}
            >
                <span className="font-mono text-secondary/80 group-hover:text-vermilion transition-colors">
                    {text}
                </span>
                <svg
                    className={`w-3.5 h-3.5 transition-colors ${copied ? 'text-green-600' : 'text-secondary/50 group-hover:text-vermilion'
                        }`}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                >
                    {copied ? (
                        <path d="M5 13l4 4L19 7" />
                    ) : (
                        <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    )}
                </svg>
            </button>
        </div>
    );
}
