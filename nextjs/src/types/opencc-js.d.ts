// opencc-js 没带类型声明；只声明用到的 t2cn（繁→简）入口。
declare module 'opencc-js/t2cn' {
    export function Converter(options: { from: string; to: string }): (text: string) => string;
}
