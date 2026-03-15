'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { DataSource, GITHUB_BOOK_INDEX, SOURCE_COOKIE_NAME } from '@/lib/constants';

interface SourceContextType {
    source: DataSource;
    setSource: (source: DataSource) => void;
    isAutoDetected: boolean;
    checkConnectivity: () => Promise<void>;
}

const SourceContext = createContext<SourceContextType | undefined>(undefined);

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
        // 暂时锁定为 github
        setInternalSource('github');
        setSourceCookie('github');
    }, []);

    const checkConnectivity = useCallback(async () => {
        // 暂时禁用自动检测，总是锁定为 github
        setInternalSource('github');
    }, []);

    useEffect(() => {
        // 暂时锁定为 github，忽略 Cookie 和自动检测
        setInternalSource('github');
    }, []);

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
