import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // 开源古籍主题色
      colors: {
        paper: "#F5F2E9", // 宣纸色背景
        ink: "#2C2C2C", // 墨黑色
        vermilion: "#8B0000", // 朱砂红（主强调色）
        secondary: "#666666", // 浅灰色
        border: "#D4CFC0", // 边框色
      },
      // 字体配置
      fontFamily: {
        serif: [
          "SimSun",
          "Songti SC",
          "STSong",
          "Noto Serif SC",
          "serif",
        ],
        sans: [
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      // 响应式断点（与 Flutter 版本一致）
      screens: {
        mobile: "600px",
        tablet: "900px",
        desktop: "1200px",
      },
      // 最大内容宽度
      maxWidth: {
        content: "800px",
        "content-tablet": "600px",
      },
    },
  },
  plugins: [],
};

export default config;
