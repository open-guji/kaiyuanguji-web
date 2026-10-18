# fulltext：全文搜索后端

建全文索引包、跑检索服务、在搜索机上轮换索引。设计与接口见 [docs/design.md](docs/design.md)。

```
common.py, charmap.json   切段、字流、繁简异体归一（建包与服务共用）
build/                    build_pack.py 全量建包；update_books.py 增量；verify_pack.py 校验包；make_smoke.py 生成冒烟金标
service/                  检索服务（run.py 入口，app.py 查询路径，source_tantivy.py 读索引，ranking.py 书序）
deploy/                   搜索机脚本：install.sh、rotate.sh、rollback.sh、systemd 单元、env 模板
eval/                     评测：inproc.py（进程内召回＋延迟）、eval_recall.py／eval_latency.py（经 HTTP）、queries.json（244 条冻结查询）、books42.txt
contract/                 接口样例与冒烟查询
```

## 本地跑一遍

```bash
cd fulltext
pip install -r requirements.txt -r requirements-dev.txt
python -m pytest -q                         # 建包、检索、评测的单测
bash deploy/tests/test_deploy.sh            # 部署脚本单测（假目录、假服务）

# 取 42 部样本书（稀疏检出，约 270 MB）
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/open-guji/book-text /tmp/book-text
{ echo /index/; while read id; do t=${id: -3}; for top in Work Book; do
    echo "/$top/${t:0:1}/${t:1:1}/${t:2:1}/$id/"; done; done < eval/books42.txt; } \
  | git -C /tmp/book-text sparse-checkout set --no-cone --stdin
git -C /tmp/book-text checkout

python build/build_pack.py --text-root /tmp/book-text --out /tmp/ft --only $(paste -sd, eval/books42.txt)
python eval/inproc.py --pack /tmp/ft --text-root /tmp/book-text --books eval/books42.txt --queries eval/queries.json

# 起服务
FT_INDEX_DIR=/tmp/ft/index FT_TITLES=/tmp/ft/titles.json python service/run.py
curl 'http://127.0.0.1:8765/api/fulltext?q=學而時習之'
```

依赖：Python ≥3.10，`tantivy==0.26.2`（索引格式随版本变，建包与服务必须同版本）。
