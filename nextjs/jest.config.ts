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
        '^react-markdown$': '<rootDir>/__mocks__/react-markdown.js',
        '^remark-gfm$': '<rootDir>/__mocks__/remark-gfm.js',
    },
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
export default createJestConfig(config);
