# 展会智能镜

从 V1.1 提取的独立智能镜工程：镜端页面、管理后台、Node API 和 Android 原生镜端。未包含主站、V1.0、用户运行数据或永久密钥。

## 目录

- `src/exhibition/`：智能镜和管理后台界面。
- `server/`：多镜管理、素材、设备绑定、密钥与实时会话。
- `shared/`：镜端接口及 XMAX 区域类型。
- `android/exhibition/`：Android 镜端及带许可证的 XMAX SDK。
- `scripts/`：智能镜专用 HTTP/HTTPS 网关和 macOS 后台托管。
- `tests/`：隔离测试；供应商和摄像头使用模拟对象。

## 本地准备

需要 Node.js 22.13 或更新版本（建议 Node.js 24）和 npm。

```sh
npm ci
cp .env.example .env
npm run typecheck
npm test
npm run build
```

镜端永久密钥通过管理后台当前设置区中的 HTTPS 表单填写；也可在仅服务端读取的 `.env` 中填写默认 `XMAX_API_KEY`。密钥在本机加密保存，不进入浏览器 HTTP 页面或 Git。

每次会话使用受限临时凭证，保留有效期、撤销和异常会话记录。智能镜不设置本地累计预算；余额不足以 XMAX 实际返回为准。

## 固定局域网入口

后台：`http://xuminghong.local:10200/`（重定向 `/v1.1/exhibition`）。

镜端：`http://xuminghong.local:10200/v1.1/exhibition/screen`，自动进入同主机 `https://xuminghong.local:10202/v1.1/exhibition/screen`，保留设备参数。进入后仅准备本地取景，点击“开始体验”才启动生成。

```sh
npm run camera:certificate
npm run lan:start
npm run lan:status
npm run lan:stop
```

证书只在显式执行时生成于本工程 `.data/lan-tls/`，需要在访问设备上自行信任生成的 CA 公钥。脚本不自动安装系统信任。内部 Vite 5173、API 3002 仅监听回环地址；HTTP 10200/10201 和 HTTPS 10202 为局域网网关。HTTP 网关禁止永久密钥写入。

`lan:start` 仅支持 macOS，注册本工程独立的登录自启及退出重启服务。运行期间防止闲置睡眠，允许锁屏与屏幕熄灭；停止后释放防眠。网络变化自动刷新域名广播和备用地址。合盖、主动睡眠、退出登录、关机或断网会影响访问。端口被其他工程占用时拒绝启动，不停止现有服务。

只需前台开发时，可运行 `npm run dev`，另行运行 `npm run lan:serve` 和 `npm run camera:serve`。不要与已经占用同一端口的工程同时启动。

运行数据、凭证加密密钥和本地证书均不入库。Android debug 附带的 `openbuy_local_ca.crt` 为原展台的公开 CA 信任锚，证书脚本会同步新 CA 公钥到此资源，换用证书后须重新构建并安装 APK；不包含证书私钥。Android 的构建步骤见 `android/exhibition/README.md`。

## 仓库与验证

目标仓库：https://github.com/qwertyhorse/Miror

此次交付仅同步源码。`.gitlab-ci.yml` 禁用自动流水线，避免项目默认 Auto DevOps 自动部署；未配置站点发布任务。
