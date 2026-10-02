import type { Config } from 'jest';
import nextJest from 'next/jest.js';

const createJestConfig = nextJest({
    // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
    dir: './',
});

// Add any custom config to be passed to Jest
const config: Config = {
    coverageProvider: 'v8',
    testEnvironment: 'jsdom',
    // Add more setup options before each test is run
    setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
    // book-index-ui 0.2.25 顶层 require react-markdown / remark-gfm（ESM-only），
    // jest 默认不转译 node_modules 会炸；测试不需要真渲染 markdown，整体 mock 掉
    moduleNameMapper: {
        // 与 tsconfig paths 一致
        '^@/(.*)$': '<rootDir>/src/$1',
        '^react-markdown$': '<rootDir>/__mocks__/react-markdown.js',
        '^remark-gfm$': '<rootDir>/__mocks__/remark-gfm.js',
        // book-index-ui 0.11.0 起顶层静态 import 'opencc-js/t2cn'（ESM，jest 不转译）；测试里用它的 UMD 构建（同一份词表）
        '^opencc-js/t2cn$': '<rootDir>/node_modules/opencc-js/dist/umd/t2cn.js',
        // 异体字归一表（overview#350）：edge-functions/ 在 nextjs 之外，jest 从那里解析不到 nextjs 的 node_modules；
        // 指到同一份构建产物（JSON 与 ESM 两种入口内容相同）
        '^book-index-ui/variant-chars(\\.json)?$': '<rootDir>/node_modules/book-index-ui/dist/variant-chars.json',
    },
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
export default createJestConfig(config);
