declare module 'webtex-cn' {
  export function renderToHTML(texSource: string): string;
  export function renderToDOM(
    texSource: string,
    container: HTMLElement,
    options?: { cssBasePath?: string }
  ): void;
  export function renderToPage(texSource: string): string;
  export function render(
    url: string,
    container: HTMLElement,
    options?: { cssBasePath?: string }
  ): Promise<void>;
  export function getTemplates(): Array<{ id: string; name: string }>;
  export function setTemplate(templateId: string, basePath?: string): void;
  export function parse(source: string): { ast: any; warnings: string[] };
  export function layout(ast: any): any;
  export class HTMLRenderer {
    constructor();
    render(ast: any, layoutResult: any): string[];
  }
}
