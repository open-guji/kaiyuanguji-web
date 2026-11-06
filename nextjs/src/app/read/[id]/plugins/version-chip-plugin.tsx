import type { ReaderPlugin } from 'book-index-ui';
import TextVersionChip from '../TextVersionChip';
import { originalMetaOf } from './chapter-meta';

/** 书名栏里的「文本 v0.1.4」芯片：只给 original 版本出，取自 ctx 里的章条目 */
export const versionChipPlugin: ReaderPlugin = {
    id: 'kyg:version-chip',
    toolbar: {
        slot: 'subtitle',
        order: 30,
        render: (api) => {
            const m = originalMetaOf(api.ctx);
            return m ? <TextVersionChip versions={m.versions} /> : null;
        },
    },
};
