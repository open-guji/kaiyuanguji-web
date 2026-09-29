# 用户逐页意见第一批：改前 / 改后（1440 宽，整页）

关联 overview#267，PR：open-guji/kaiyuanguji-web `claude/fxw-user-feedback-1`。
两组图都是本地 `next build && next start`（CI 同款环境）截的，改前 = 当时的 main，改后 = 本 PR。

**读图前请注意**：截图的沙箱里浏览器取不到数据 CDN，所以

- 阅读页正文是「无法加载这一卷」（改前改后都一样，不是本次改动造成的）；页面外壳、导航、目录栏和新地址是真的；
- 反馈页列表是「网络错误」（同样是取不到接口）。

| 页面 | 改前 | 改后 |
|---|---|---|
| 首页（含页脚） | ![](before/home.png) | ![](after/home.png) |
| 古籍总目（不再有页脚） | ![](before/catalog.png) | ![](after/catalog.png) |
| 关于（删两节；页脚） | ![](before/about.png) | ![](after/about.png) |
| 阅读页（新地址 `/read/d59f2htm01du?kind=collated`，旧地址 `/item/d59f2htm01du/read?kind=collated`） | ![](before/reader.png) | ![](after/reader.png) |
| 反馈（页脚黑底） | ![](before/feedback.png) | ![](after/feedback.png) |
| 隐私（页脚黑底） | ![](before/privacy.png) | ![](after/privacy.png) |
| 404（页脚黑底） | ![](before/notfound.png) | ![](after/notfound.png) |
| 联系（页脚黑底，顺带） | ![](before/contact.png) | ![](after/contact.png) |

手机 390 宽（只有改后，横向不溢出）：[首页](after/home-390.png)、[关于](after/about-390.png)。
