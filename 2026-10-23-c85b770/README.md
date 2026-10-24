# 截图 2026-10-23-c85b770

目标：https://staging.openguji.com

| 页面 | 桌面 1440 | 手机 390 |
|---|---|---|
| **首页**<br>`/` | <img src="home-1440.jpg" width="640"> | <img src="home-390.jpg" width="200"> |
| **古籍总目（經部）**<br>`/catalog` | <img src="catalog-1440.jpg" width="640"> | ❌ page.goto: net::ERR_CONNECTION_REFUSED at https://staging.openguji.com/catalog |
| **古籍总目·未分类**<br>`/catalog?node=unclassified` | <img src="catalog-unclassified-1440.jpg" width="640"> | <img src="catalog-unclassified-390.jpg" width="200"> |
| **搜索：史記**<br>`/book-index?q=%E5%8F%B2%E8%A8%98` | ❌ page.goto: net::ERR_CONNECTION_REFUSED at https://staging.openguji.com/book-index?q=%E5%8F%B2%E8%A8%98 | <img src="search-390.jpg" width="200"> |
| **Work：史記**<br>`/item/d59f20aowb9c` | <img src="work-shiji-1440.jpg" width="640"> | <img src="work-shiji-390.jpg" width="200"> |
| **Book：程甲本**<br>`/item/96kzkdm8e8` | ❌ page.goto: net::ERR_CONNECTION_REFUSED at https://staging.openguji.com/item/96kzkdm8e8 | <img src="book-chengjia-390.jpg" width="200"> |
| **Collection：武英殿聚珍版叢書**<br>`/item/8rlcsybg2hhf` | ❌ page.goto: net::ERR_CONNECTION_REFUSED at https://staging.openguji.com/item/8rlcsybg2hhf | <img src="collection-juzhen-390.jpg" width="200"> |
| **Entity：朱熹**<br>`/item/hixhd2h9bgah` | ❌ page.goto: net::ERR_CONNECTION_REFUSED at https://staging.openguji.com/item/hixhd2h9bgah | ❌ page.goto: net::ERR_CONNECTION_REFUSED at https://staging.openguji.com/item/hixhd2h9bgah |
| **阅读首页**<br>`/read` | <img src="read-home-1440.jpg" width="640"> | <img src="read-home-390.jpg" width="200"> |
| **阅读页·整理本（直齋書錄解題）**<br>`/read/d59f2htm01du` | <img src="read-collated-1440.jpg" width="640"> | <img src="read-collated-390.jpg" width="200"> |
| **阅读页·全文（詩序，有版本下拉框）**<br>`/read/d59f2ew0ctmo` | ❌ page.goto: net::ERR_CONNECTION_REFUSED at https://staging.openguji.com/read/d59f2ew0ctmo | <img src="read-fulltext-390.jpg" width="200"> |
| **关于**<br>`/about` | <img src="about-1440.jpg" width="640"> | <img src="about-390.jpg" width="200"> |
| **联系（并入关于页）**<br>`/about#联系` | <img src="contact-1440.jpg" width="640"> | <img src="contact-390.jpg" width="200"> |
| **隐私**<br>`/privacy` | <img src="privacy-1440.jpg" width="640"> | <img src="privacy-390.jpg" width="200"> |
| **反馈**<br>`/feedback` | <img src="feedback-1440.jpg" width="640"> | <img src="feedback-390.jpg" width="200"> |
| **404：不存在的条目**<br>`/item/nonexistent000` | <img src="not-found-1440.jpg" width="640"> | <img src="not-found-390.jpg" width="200"> |
