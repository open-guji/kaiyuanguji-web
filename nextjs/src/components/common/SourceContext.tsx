'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { DataSource, SOURCE_COOKIE_NAME } from '@/lib/constants';

interface SourceContextType {
    source: DataSource;
    setSource: (source: DataSource) => void;
    isAutoDetected: boolean;
    checkConnectivity: () => Promise<void>;
}

const SourceContext = createContext<SourceContextType | undefined>(undefined);

/** 检测 bundle 数据是否可用（同域 /data/index.json） */
async function detectBundle(): Promise<boolean> {
    try {
        const resp = await fetch('/data/index.json', {
            method: 'HEAD',
            signal: AbortSignal.timeout(3000),
        });
        return resp.ok;
    } catch {
        return false;
    }
}

export function SourceProvider({
    children
}: {
    children: React.ReactNode;
}) {
    const [source, setInternalSource] = useState<DataSource>('github');
    const [isAutoDetected, setIsAutoDetected] = useState(false);

    // 设置 cookie
    const setSourceCookie = (src: DataSource) => {
        document.cookie = `${SOURCE_COOKIE_NAME}=${src}; path=/; max-age=${60 * 60 * 24 * 365}`;
    };

    const setSource = useCallback((src: DataSource) => {
        setInternalSource(src);
        setSourceCookie(src);
        setIsAutoDetected(false);
    }, []);

    const checkConnectivity = useCallback(async () => {
        // 优先检测 bundle 模式
        if (await detectBundle()) {
            setInternalSource('bundle');
            setIsAutoDetected(true);
            return;
        }
        // fallback 到 github
        setInternalSource('github');
        setIsAutoDetected(true);
    }, []);

    useEffect(() => {
        checkConnectivity();
    }, [checkConnectivity]);

    return (
        <SourceContext.Provider value={{ source, setSource, isAutoDetected, checkConnectivity }}>
            {children}
        </SourceContext.Provider>
    );
}

export function useSource() {
    const context = useContext(SourceContext);
    if (context === undefined) {
        throw new Error('useSource must be used within a SourceProvider');
    }
    return context;
}
