#!/bin/bash
# 假 systemctl：记录调用；reload/restart 成功（假服务现读符号链接，无需真重载）
echo "$@" >> "${FT_SYSTEMCTL_LOG:-/dev/null}"
exit 0
