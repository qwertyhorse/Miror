#!/bin/bash
cd -- "$(dirname -- "$0")"
bash scripts/launch-mac.sh start
mirror_status=$?
if [ "$mirror_status" -ne 0 ]; then
  echo "启动未完成。请查看上面的错误。按回车关闭。"
  read -r
fi
exit "$mirror_status"
