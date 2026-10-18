#!/bin/bash
# 服务启动包装：systemd 单元和 rotate.sh 的自检临时实例共用。配置全在环境变量（/etc/fulltext.env）。
cd /opt/fulltext/app || exit 1
exec /usr/bin/python3 -I /opt/fulltext/app/service/run.py
