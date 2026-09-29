// opencc-js 没带类型声明；只声明用到的子路径（服务端繁简转换，lib/server/simplify.ts）
declare module 'opencc-js/t2cn' {
    export function Converter(options: { from: string; to: string }): (text: string) => string;
}
