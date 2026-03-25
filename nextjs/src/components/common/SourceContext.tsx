'use client';

import React, { createContext, useContext } from 'react';
import { DataSource, DATA_SOURCE } from '@/lib/constants';

interface SourceContextType {
    source: DataSource;
}

const SourceContext = createContext<SourceContextType | undefined>(undefined);

export function SourceProvider({
    children
}: {
    children: React.ReactNode;
}) {
    // 数据源由构建时环境变量 NEXT_PUBLIC_DATA_SOURCE 决定，不做运行时探测或 fallback
    return (
        <SourceContext.Provider value={{ source: DATA_SOURCE }}>
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
