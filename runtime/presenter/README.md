# Ubuntu 双翻页笔

两个 USB 接收器接在同一台 Ubuntu 电脑，每个接收器绑定后台的一台智能镜。上翻、上箭头、左箭头切到上一款；下翻、下箭头、右箭头切到下一款。无需切换窗口焦点，长按只翻一次。待机时选款，体验中切换素材，不会自动开始体验。

默认连接展会后台 `http://xuxin.local:10101/`。两个屏幕须已打开各自智能镜的画面；本程序不创建或移动屏幕窗口。

## 安装

在展会电脑登录日常使用的桌面账户，启动现有展会程序，接上两个独立接收器。解压安装包，在解压目录打开终端：

```bash
bash runtime/presenter/install.sh
```

依次选择接收器与对应智能镜。安装器显示接收器名称、USB 路径和后台实际设备名称，不预填本 Mac 的设备编号。若两个名称相同，可先用 `python3 scripts/presenter-linux.py --list` 对照拔插前后的路径，再同时接入并安装；不要选择日常键盘。

安装器使用电脑已有的 Node.js 22 或更新版及 Python 3，无需 npm/pip 下载。输入权限需要管理员密码时，安装器会调用 `sudo`，只为选定接收器安装 udev 规则。请直接以桌面账户运行安装器，不要使用 `sudo bash`。

安装完成后后台运行，登录时自动启动。无序列号的接收器按 USB 插口区分，保持两个接收器及集线器的插口不变；换口或互换接收器后重新绑定。

## 检查与停止

```bash
systemctl --user status miror-presenter.service
journalctl --user -u miror-presenter.service -n 50 --no-pager
systemctl --user restart miror-presenter.service
systemctl --user disable --now miror-presenter.service
```

最后一条停止翻页服务并关闭其登录自启，接收器恢复普通键盘行为。现有展会服务不受影响。

配置保存在 `~/.config/miror-presenter/bindings.json`，程序保存在 `~/.local/share/miror-presenter/`，重复安装会备份原配置。每支笔独立读取对应智能镜的最新状态，并通过现有 V1.1 API 发出一次选款命令。后台离线时释放接收器，恢复后重新连接；拔插后按原绑定恢复，不补发旧按键。

权限不足、设备身份不符或绑定有歧义时会停止接管，在日志中给出原因。修正后重启翻页服务。登录桌面的用户须与安装服务的用户相同。

## 到现场验收

1. 第一支笔上下各按一次，只应改变第一块屏幕。
2. 第二支笔上下各按一次，只应改变第二块屏幕。
3. 同时按两支笔，各自翻页；长按只翻一次。
4. 拔插一个接收器后原位接回，确认仍控制原屏幕。
5. 重启并登录 Ubuntu，确认服务自动恢复。

当前交付完成代码与离线自动化验证，尚未在 xuxin Ubuntu 电脑上安装，也未完成两个独立接收器的实机验收。

## 离线准备与开发验证

已有该 Ubuntu 电脑的实际绑定配置时，可用 `--config /绝对路径/bindings.json --prepare-only` 准备安装文件；此模式不申请输入权限、不启动服务，也拒绝覆盖已有安装。更新已有安装请去掉 `--prepare-only`。不要把其他电脑的 USB 路径用于现场绑定。

```bash
node --test scripts/presenter-router.test.mjs scripts/presenter-service.test.mjs scripts/presenter-setup.test.mjs
python3 scripts/presenter-linux.test.py
```

Linux helper 只使用 Python 标准库，`--list` 只读枚举；`--validate PATH` 只校验配置；`--check --config PATH` 只读检查设备身份和访问权限；`--config PATH` 才独占读取明确绑定的接收器。支持 PageUp/PageDown 及四个方向键，忽略其他按键和自动重复。独占会暂时阻止所选接收器的键盘接口向桌面发送按键，服务退出时释放。
