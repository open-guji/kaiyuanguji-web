#!/bin/bash
# 服务启动包装：systemd 单元和 rotate.sh 的自检临时实例共用。
# 入口命令待 F4 步 3 定稿（Eira）；定了之后只改这一行，单元与脚本都不用动。
cd /opt/fulltext/app || exit 1
exec /usr/bin/python3 -m service.main
