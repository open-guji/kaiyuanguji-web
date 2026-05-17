import type { IndexEntry } from 'book-index-ui';

const REPO_DRAFT = 'https://github.com/open-guji/book-index-draft';
const REPO_OFFICIAL = 'https://github.com/open-guji/book-index';

export function repoBase(isDraft?: boolean): string {
    return isDraft ? REPO_DRAFT : REPO_OFFICIAL;
}

export function repoLabel(isDraft?: boolean): string {
    return isDraft ? 'book-index-draft' : 'book-index';
}

const dirOf = (path: string) => {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(0, i) : '';
};

export interface SourceLink {
    href: string;
    label: string;
}

/** 基于一条 IndexEntry 推导各 tab 对应的源文件链接。 */
export function buildSourceLinks(entry: IndexEntry) {
    const base = repoBase(entry.isDraft);
    const label = repoLabel(entry.isDraft);
    const path = entry.path || '';
    const dir = dirOf(path);
    const id = entry.id;

    const basic: SourceLink = {
        href: `${base}/blob/main/${path}`,
        label: `在 GitHub 查看本条目源文件（${label}）`,
    };

    const collatedDir: SourceLink = {
        href: `${base}/tree/main/${dir}/${id}/collated_edition`,
        label: `在 GitHub 查看整理本源文件目录（${label}）`,
    };

    const collatedJuan = (juanFile: string): SourceLink => ({
        href: `${base}/blob/main/${dir}/${id}/collated_edition/${juanFile}`,
        label: `在 GitHub 查看本卷源文件（${label}）`,
    });

    const fullTextDir: SourceLink = {
        href: `${base}/tree/main/${dir}/${id}/full_text`,
        label: `在 GitHub 查看全文源文件目录（${label}）`,
    };

    const fullTextChapter = (file: string): SourceLink => ({
        href: `${base}/blob/main/${dir}/${id}/full_text/${file}`,
        label: `在 GitHub 查看本章源文件（${label}）`,
    });

    const catalog = (resourceId: string): SourceLink => ({
        href: `${base}/blob/main/${dir}/${id}/${resourceId}/volume_book_mapping.json`,
        label: `在 GitHub 查看丛编目录源文件（${label}）`,
    });

    const lineage: SourceLink = {
        href: `${base}/blob/main/${dir}/${id}/lineage_graph.json`,
        label: `在 GitHub 查看版本传承源文件（${label}）`,
    };

    return { basic, collatedDir, collatedJuan, fullTextDir, fullTextChapter, catalog, lineage };
}

/** 仓库根：用于首页/索引浏览器右上角。 */
export const REPO_ROOT_DRAFT: SourceLink = {
    href: REPO_DRAFT,
    label: 'book-index-draft：所有索引数据的开源仓库',
};
