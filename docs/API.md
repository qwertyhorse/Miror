# 会展前端 API

接口实现：`server/http.ts`；共享类型：`shared/exhibition.ts`。本包仅提供会展接口。

## 地址与请求规则

| 用途 | 地址 |
| --- | --- |
| 工作人员后台 | `http://xuminghong.local:10601/` |
| HTTP API 前缀 | `http://xuminghong.local:10601/v1.1/api/exhibition` |
| 消费者兼容入口 | `http://xuminghong.local:10200/v1.1/api/exhibition` |
| 镜端与密钥安全表单 | `https://xuminghong.local:10202/v1.1/api/exhibition` |

下文 `M` 表示 `/v1.1/api/exhibition/mirrors/{mirrorId}`，例如 `mirrorId=default`。`S` 表示 `M/sessions/{sessionId}`。镜编号来自设备列表，不存在的编号返回 404，不回退到默认设备。

- 浏览器使用当前页面同源的相对地址；写请求使用 `Content-Type: application/json`，并保留浏览器的 `Origin`。HTTP 网关拒绝永久密钥写入。
- Node API 仅监听回环地址；网关将 `/v1.1/api/...` 转发为内部 `/api/...`。不要把内部 API 端口直接作为局域网入口。
- 成功直接返回 JSON 对象，不包 `data`；图片返回二进制。响应禁止缓存。
- 常规 JSON 请求上限 16 KiB；终端连接 `/terminals/connect` 为 64 KiB，摄像头操作与密钥写入为 2 KiB；素材上传按当前设置单独计算限制。
- 状态写入建议携带最新 `expectedRevision`。409 `EXHIBITION_STALE_REVISION` 时重新读取状态、核对操作后再提交。密钥有独立的 `revision`，不能使用镜状态版本代替。
- `updatedAt`、`boundAt`、`expiresAt`（配对码）等数字时间为 Unix 毫秒；会话中的 `createdAt`、`updatedAt`、`expiresAt` 为 ISO 时间字符串。

## 体验协议 2 与恢复

API、Web 与 Android 须配套升级；当前 Android 版本为 0.3.3（versionCode 11），后台摄像头控制要求 0.3.2 或更新版本。创建实时会话 `POST M/live/session` 必须携带 `X-Miror-Protocol: 2`；旧镜端返回 426 `EXHIBITION_CLIENT_UPGRADE_REQUIRED`，不签发临时凭证。

`POST M/command` 支持 `commandId`（8–100 位字母、数字、下划线或连字符）。客户端同一次操作重试须沿用编号；同编号同内容返回当前权威快照，同编号不同内容返回 409 `EXHIBITION_COMMAND_CONFLICT`。服务端持久化去重；`expectedRevision` 不参与内容指纹。`end/idle/pause` 优先执行，不因旧 revision 阻止停止。`keepalive` 仅用于正在生成/展示的体验，取消空闲提醒并重新开始空闲计时。

状态的 `lifecycle` 区分业务体验与连接：`experienceId` 跨凭证续接保持不变，`controllerEpoch` 随新连接增加，`terminalRevision` 随结束/工作人员暂停增加。业务 `state` 为 idle/active/paused/ended；连接为 idle/connecting/running/recovering/needs_assistance/cleaning。为兼容既有页面，`phase=paused` 也可能表达需要人工处理；判断工作人员暂停应查看 `lifecycle.reason=staff_pause`。

- 心跳每 3 秒，单请求 4 秒超时。服务端占用 20 秒到期；终端以请求发出的单调时钟计时并留 2 秒余量。短暂控制请求失败不直接拆 RTC；明确撤销或租约截止立即清理。
- `POST M/live/error` 可携带 `reason`，区分 rtc_failed、lease_expired、credential_expired、segment_exhausted、command_unknown、camera_lost、provider_rejected、mox_completed。到期/耗尽须经服务端现有记录核对。
- 技术恢复保持同一体验和最新选择，先确认旧凭证停止，再签发下一段。异常恢复连续最多 2 次、5 分钟最多 3 次；健康 60 秒可重置连续失败计数。正常续接不计为异常重试。工作人员暂停不自动继续，MoX 不自动重播。
- 未确认签发/停止的记录阻止同镜新签发。端侧关闭 SDK 不等于云端停止；停止确认仍由现有会话服务核对。
- 手动选择将轮播切回手动。手动体验空闲提醒宽限 15 秒，轮询和后台素材上传不推迟截止时间；自动轮播、显式连续模式保留各自策略。
- `GET M/diagnostics` 导出当前生命周期、生效会话策略和最近最多 2,000 条脱敏转换事件，不含密钥或画面。常规 GET/长轮询返回快照，后台 watchdog 推进状态。

## 数据升级与运行

连接服务挂接后，SQLite `mirror_states` 中 schemaVersion 4 为镜状态权威，`mirror_commands` 保存命令去重，`mirror_events` 保存有界事件。首次启动从已有 `exhibition.json` 校验并迁移，后续不双写活动状态；JSON 只作为迁移输入保留。会话凭证继续由原加密会话存储管理。无连接服务的独立演示仍使用原 JSON 路径。

升级须在维护窗口停止接待，确认所有旧段已停止，停止旧进程，完整备份数据目录（SQLite 及其 WAL/SHM、素材、设备注册、密钥加密配置），再配套升级 API、Web 和 APK。首次恢复会结束遗留顾客体验并隔离旧授权，禁止自动重播。无效或未来协议的持久化状态启动拒绝载入，不能用空状态覆盖。

回退前先清理新版本连接，再恢复兼容的完整备份；不能仅把旧程序指向新数据库或把残留 JSON 当作当前状态。仍有未确认凭证时保持生成禁用并核对，不清空会话表绕过门禁。

## 设备与绑定

| 方法 | 路径 | 请求体 | 成功响应 |
| --- | --- | --- | --- |
| GET | `/v1.1/api/exhibition/mirrors` | — | 200 `ExhibitionMirrorList` |
| POST | `/v1.1/api/exhibition/mirrors` | `{ "name": "右侧智能镜" }` | 201 `ExhibitionMirrorSummary` |
| PATCH | `M` | `{ "name": "入口智能镜" }` | 200 `ExhibitionMirrorSummary` |
| GET | `M` | — | 200 `ExhibitionState` |
| GET | `M/changes?after={revision}` | — | 200 最新 `ExhibitionState`；相同版本等待变化，最多 8 秒 |
| POST | `M/copy` | `{ "sourceMirrorId": "default", "copyLooks": true, "copySettings": true, "expectedRevision": 12 }` | 200 目标镜状态 |
| GET | `/v1.1/api/exhibition/native-identity` | — | 200 `{ "native": false }` |
| POST | `/v1.1/api/exhibition/terminals/connect` | 见下例 | 200 `ExhibitionDeviceConnection` |
| POST | `M/binding` | `{ "code": "1234" }` | 200 `ExhibitionDeviceBinding` |
| DELETE | `M/binding` | `{ "terminalId": "terminal-…" }` | 200 `{ "binding": null }` |
| GET | `M/camera` | — | 200 `ExhibitionCameraStatus` |
| POST | `M/camera` | `{ "terminalId": "terminal-…", "action": "open" }` | 200 `ExhibitionCameraStatus` |

名称为 1–40 字且不能重名。复制至少选择一种内容，目标镜应结束体验；复制素材会替换目标素材，并先保存备份，密钥、绑定、会话和日志不从来源镜复制。

设备列表响应示例：

```json
{
  "defaultMirrorId": "default",
  "mirrors": [
    {
      "id": "default",
      "name": "智能镜 1",
      "phase": "idle",
      "revision": 2,
      "providerMode": "demo",
      "updatedAt": 1791770400000,
      "binding": null
    }
  ]
}
```

镜端首次连接请求示例（设备自行生成并持久保存身份；下列值仅为虚构示例）：

```json
{
  "terminalId": "terminal-11111111-1111-4111-8111-111111111111",
  "token": "example_terminal_token_32_characters_long",
  "label": "入口大屏",
  "platform": "browser"
}
```

未绑定响应示例：

```json
{
  "terminalId": "terminal-11111111-1111-4111-8111-111111111111",
  "mirrorId": null,
  "code": "1234",
  "expiresAt": 1791771000000
}
```

绑定后同一请求返回 `mirrorId` 和 `mirrorName`，不再返回配对码。配对码为 4 位数字，有效期 10 分钟、使用一次后失效；镜端每 10 秒连接刷新在线状态，30 秒未连接视为离线。API 接受 32–512 位可见 ASCII 的设备 `token`；本包浏览器生成并保存 64 位随机十六进制值，服务端仅保存其哈希。已登记设备使用错误 token 返回 403。建立绑定要求镜处于 `idle` 或 `select`，且无实时会话或未确认停止的连接。后台可在体验中主动解绑：先校验当前终端身份，再结束体验、解除绑定并清理连接；云端停止未确认时保留记录，阻止新的绑定和会话签发。

## 每镜摄像头检测

后台「镜端设备」中的「切换摄像头」只向当前绑定镜端发起请求，不枚举后台电脑的摄像头。镜端收到请求后在本机打开设备列表、重新检测和预览面板；保存或取消在镜端完成，选择留在该镜端。后台只显示设备元数据与检测状态，不接收画面，也不会为检测启动 XMAX。

网页镜端保留常驻「摄像头」入口，绑定后也可在正常取景时直接选择、预览和保存。已绑定的本机入口复用同一 `POST M/camera`，携带当前 `terminalId` 与 `bindingId`；服务端拒绝旧绑定版本，客户端核对返回请求后原地打开面板。未绑定的本机预览只保存浏览器的摄像头偏好，已绑定其他镜端的预览页不能操作摄像头。体验中入口保持可见，结束体验并完成清理后可切换。

镜端的 `terminals/connect` 增加 `cameraCapabilities: { "version": 1 }`。服务端返回当前绑定的 `cameraBindingId`；支持该能力的已绑定镜端可在后续连接中携带 `cameraReport`：

```json
{
  "mirrorId": "default",
  "bindingId": "服务端返回的绑定标识",
  "requestId": "检测请求编号，日常状态上报为 null",
  "status": "preview",
  "devices": [{ "id": "本机摄像头 ID", "label": "USB 摄像头", "kind": "external" }],
  "selectedDeviceId": "本机当前选择的摄像头 ID",
  "activeDeviceId": "实际取景的摄像头 ID"
}
```

状态为 `ready/scanning/preview/error/permission-required/busy/closed`；设备 `kind` 为 `external/back/front/unknown`，自动选择时 `selectedDeviceId` 为 null。服务端验证终端凭据、当前绑定标识及请求编号，返回 `cameraReportAccepted`；旧绑定或过期报告不会覆盖当前镜的数据。每镜状态由 `GET M/camera` 和设备列表的 `binding.camera` 返回，额外区分未绑定、离线、旧客户端、待打开和请求过期。

`POST M/camera` 只接受当前绑定终端的 `open` 操作，可选 `bindingId` 必须匹配当前绑定版本。返回的请求也会经该终端下次连接传递，包含编号、镜/终端/绑定标识及 120 秒有效期。重复点击复用未完成请求；离线、旧客户端、体验中或云端清理未完成时拒绝。有效检测请求阻止开始/恢复体验与签发实时会话，关闭、失败、忙碌或到期后解除；客户端也在面板打开期间阻止生成。请求与检测快照不写入永久设备配置，重启或重新绑定后不重放，须重新检测。旧版 Android 需升级到 0.3.2 才支持此入口。

独立 `camera-check.html` 仍用于打开该页面的本机检测，不作为后台远程检测的替代入口。

## 镜状态与操作

`GET M` 返回完整 `ExhibitionState`，包括：

| 字段 | 含义 |
| --- | --- |
| `mirrorId`, `revision` | 镜编号与状态版本 |
| `phase` | `idle` / `select` / `positioning` / `generating` / `showcase` / `paused` |
| `experienceMode` | `free` / `charx` / `clothx` / `vibex` / `dimx` / `mox` |
| `providerMode` | `demo` / `xmax` |
| `looks`, `enabledLookIds` | 全部素材与启用素材；播放仅使用当前模式启用项 |
| `selectedLookId`, `displayedLookId` | 当前选择与实际已展示素材，可能为 null |
| `categories`, `tags` | 平面分类和标签 |
| `sessionNumber`, `generationNumber` | 体验轮次与生成代数 |
| `generationReadyAt`, `autoSwitchAt` | 服务器截止时间，未启用时为 null |
| `settings` | 上传限制、自动返回、轮播、皮肤、手势识别和单轮限制设置 |
| `live` | 当前实时占用信息，无会话时为 null |
| `logs` | 最近 40 条日志，最新在前 |

`POST M/command` 返回 200 完整镜状态。示例：

```js
const M = '/v1.1/api/exhibition/mirrors/default';
const state = await fetch(M, { cache: 'no-store' }).then(r => r.json());
const response = await fetch(`${M}/command`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'begin', expectedRevision: state.revision }),
});
const next = await response.json();
if (!response.ok) throw new Error(next.message);
```

已有启用素材时，`begin` 成功响应中的相应字段示例（完整响应还包含素材、设置等字段）：

```json
{
  "mirrorId": "default",
  "revision": 13,
  "phase": "generating",
  "selectedLookId": "commute",
  "displayedLookId": null,
  "experienceMode": "clothx",
  "providerMode": "demo",
  "sessionNumber": 1,
  "generationNumber": 1,
  "live": null
}
```

| `action` | 附加字段 | 允许阶段 / 行为 |
| --- | --- | --- |
| `select` | `lookId` | `idle` / `select`，选择当前模式已启用素材 |
| `begin` | — | `idle` / `select`，开始一轮；实时模式等待镜端连接 |
| `keepalive` | — | `generating` / `showcase`，取消空闲提醒并重新计时 |
| `confirm` | — | 仅旧客户端 `positioning` 阶段兼容 |
| `switch` | `lookId` | `generating` / `showcase`，换到指定已启用素材并切回手动轮播模式 |
| `next` / `previous` | — | `generating` / `showcase`，按素材顺序切换并切回手动轮播模式 |
| `pause` | — | `generating` / `showcase`，暂停并释放实时会话 |
| `resume` | — | `paused`，上次会话停止确认后继续 |
| `end` | — | 结束体验并返回 `select`；没有可用素材时为 `idle` |
| `idle` | — | 结束体验并返回待机 |
| `recover` | — | 仅已本地结束、签发状态未知的会话；保留异常记录并释放本地占用 |
| `reorder` | `experienceMode`, `lookIds` | `idle` / `select`；提交该模式全部素材 ID，包含禁用项，不重复不遗漏 |
| `configure` | 见下表 | 大部分设置要求 `idle` / `select` |

`configure` 可提交下列字段的一个或多个：

| 字段 | 合法值 |
| --- | --- |
| `enabledLookIds` | 全库已启用 ID 数组，不重复；可为空 |
| `experienceMode` | 六种模式之一，切换前应等待实时会话停止 |
| `providerMode` | `demo` / `xmax`；启用 `xmax` 前必须配置凭证 |
| `switchMode` | `manual` / `auto` |
| `autoSwitchSeconds` | 5–600 整数秒；仅此字段和 `switchMode` 可在体验中调整 |
| `autoReturnSeconds` | 0 关闭，或 15–600 整数秒 |
| `uiSkinPreset` | `crystal` / `brand`，选择后替换自定义皮肤 |
| `materialDrawerColumns` | `1` / `2`，镜端素材栏列数；默认 `2`，每镜独立保存，结束体验后可修改 |
| `uploadLimits` | 下面的完整限制对象 |
| `gestureRecognition` | 下面的完整识别对象；仅待机/选材且 `live=null` 时可改 |
| `sessionLimits` | 完整对象 `{ "credits": 30, "expireSeconds": 120 }`；积分 1–1000000 或 `null` 表示不限，有效期 1–86400 秒（不限时至少 60 秒），数值均为整数；仅待机/选材且 `live=null` 时可改 |

单轮限制按镜保存，默认 30 credits / 120 秒。旧配置没有此字段时沿用服务端默认值；状态中的 `settings.sessionLimits` 返回当前镜的设置。复制设备设置包含这项限制。保存只影响随后签发的临时凭证，不修改已签发凭证；`live/session` 只读取服务器保存的限制，客户端请求里的积分或有效期不能覆盖。

`credits: null` 表示体验不限积分、自动分段续接，默认仍使用有限模式。每段签发 3000 credits 的可撤销临时凭证，有效期使用本镜 `expireSeconds`；不向 XMAX 发送 `null` 或伪造“无限”值。`live/status.perSessionLimit` 与 `credentials.perSessionLimit` 在不限模式返回每段实际的 3000。签发结果 `exhibition.continuous=true` 冻结该段的续接模式。不限体验运行期间不因 `autoReturnSeconds` 无操作返回待机；手动结束仍会结束体验。连接错误或心跳失联先停止当前段，再按协议 2 的恢复规则处理。

手势识别默认值（`configure` 更新此项时必须提交完整对象）：

```json
{
  "gestures": ["open_palm"],
  "minHandDetectionConfidence": 0.35,
  "minHandPresenceConfidence": 0.35,
  "minTrackingConfidence": 0.5,
  "palmConfirmMs": 300,
  "palmReleaseMs": 500,
  "palmLowerMs": 350,
  "lowerTrackingGraceMs": 500,
  "maxFps": 15,
  "inputLongEdge": 720
}
```

`gestures` 可选 `open_palm`、`wave`，支持多选，不允许重复；空数组关闭识别。三项置信度为 0.1–0.9；`palmConfirmMs` 确认时间为 150–1000 整数毫秒；`palmReleaseMs` 收手间隔为 300–1500 整数毫秒；`palmLowerMs` 自然放手复位时间为 150–1500 整数毫秒；`lowerTrackingGraceMs` 放手过程的短暂跟踪丢失容错为 100–1000 整数毫秒；帧率为 5–30 整数；输入长边为 480/720/960。新提交必须包含全部字段；缺失或非法配置返回 `EXHIBITION_INVALID_SETTINGS`，不会部分写入。复制设备设置包含此项。配置范围由 `shared/exhibitionGestures.ts` 统一校验。

读取旧设备数据时，若识别配置合法但缺少 `palmLowerMs` 或 `lowerTrackingGraceMs`，仅为缺少的字段补入默认值，保留原置信度、时长和已关闭的手势选项，并持久化迁移结果。整个识别配置缺失或包含显式非法值时，仍按原规则回退到完整默认值。

展掌触发后，镜端支持同一操作者自然下放手臂，低位确认达到 `palmLowerMs` 后复位，再抬手重新确认；低位停留不会连续触发。此复位需要可信的人体与手腕跟踪，在 `lowerTrackingGraceMs` 范围内的短暂跟踪缺失可保留已开始的放手确认，但必须再次观测到可信的低位手腕才能完成，超时则重新计时，不会仅凭跟踪丢失复位。纯单手取景仍可通过握拳或移出画面复位，间隔采用 `palmReleaseMs`。仅开启 `wave` 时保留原挥手规则。`maxFps` 是采样上限，实际帧率取决于本机推理耗时。镜端的“已选中”“换装已提交”仅表示选装指令被接受，不代表生成画面已出现。

手掌允许自然五指并拢，默认连续可见约 300 ms 确认，持续展示只触发一次；收手后才能再次展掌。仅勾选挥手时静止展示手掌不触发。镜端复用摄像头，只重建需要更新模型阈值的识别 Worker，不会因此启动新的 XMAX 生成。

默认上传限制：

```json
{
  "maxFileSizeMB": 10,
  "minWidth": 256,
  "maxWidth": 8192,
  "minHeight": 256,
  "maxHeight": 8192
}
```

可配置文件上限 1–20 MiB；各宽高范围 64–8192 px，最小值不能超过最大值，总像素不超过 3200 万。两张素材图分别校验，POST 与 PATCH 的请求容量按两张图的 base64 大小计算。升级仅迁移旧默认尺寸限制，保留已自定义的限制。

## 素材、分类与皮肤

| 方法 | 路径 | 请求体 | 成功响应 |
| --- | --- | --- | --- |
| POST | `M/looks` | 素材元信息 + `imageBase64` + `referenceImageBase64` | 201 完整镜状态 |
| PATCH | `M/looks/{lookId}` | 要修改的元信息、可选 `imageBase64` / `referenceImageBase64` + `expectedRevision` | 200 完整镜状态 |
| DELETE | `M/looks/{lookId}` | `{ "expectedRevision": 12 }` | 200 完整镜状态 |
| GET / HEAD | `M/assets/{uploadId}` | — | 200 `image/webp` |
| GET / HEAD | `M/assets/{lookId}/{role}/{uuid}` | — | 200 `image/webp`；`role` 为 `display` 或 `reference` |
| POST | `M/taxonomy` | `{ "categories": ["通勤", "休闲", "礼服"], "tags": ["简约", "日常", "优雅"], "expectedRevision": 12 }` | 200 完整镜状态 |
| POST | `M/skin` | `{ "imageBase64": "…", "expectedRevision": 12 }` | 200 完整镜状态 |
| DELETE | `M/skin` | `{ "expectedRevision": 12 }` | 200 完整镜状态，恢复默认皮肤 |
| GET / HEAD | `M/skin/{skinId}` | — | 200 `image/webp` |

素材上传 JSON 示例，两种图片字段均应换成完整图片的 base64 或 data URL：

```json
{
  "name": "藏蓝西装",
  "description": "日常通勤",
  "mode": "clothx",
  "category": "通勤",
  "tags": ["简约"],
  "imageBase64": "data:image/png;base64,<完整展示图编码>",
  "referenceImageBase64": "data:image/png;base64,<完整参考图编码>"
}
```

API 名称 1–40 字；后台不要求填写名称，上传时从展示图文件名生成，编辑时保留。描述最多 120 字，每份素材最多 8 个标签；分类和标签必须已登记。两张图只接受可完整解码的静态 PNG/JPEG/WebP，分别转为 WebP。每镜最多 100 份素材，全服务同时处理最多 2 份上传。新增素材默认禁用，需通过 `configure.enabledLookIds` 启用。上传可在体验中追加，不使用全局版本锁；编辑、删除、分类调整和皮肤更换需先结束体验。

`image` 为展示图，用于素材列表、选衣和待机；`referenceImage` 为 XMAX 输入，附有独立的 `referenceImageInfo`（宽高、字节数、MIME）。服务端准备、Web/Android 上传、连续切换与 MoX 操作均使用参考图。新素材两张图必填；PATCH 未提交的图片保持原样，换图生成新资源 URL 并刷新参考图准备缓存。所有图片校验通过后才保存；处理或保存失败清理本次文件，保留原素材。

旧单图素材没有 `referenceImage` 时继续以 `image` 作为生成输入；首次仅更换展示图会把原图固定为参考图。Free 模式必须提交 1–1000 字 `prompt`；旧素材的 `referenceKind: "none"` 继续仅使用提示词，编辑时补充参考图才转为图文生成，转到其他模式须补参考图。新建 Free 素材也必须提交双图。

返回的图片 URL 为版本相对路径，如 `/api/exhibition/mirrors/default/assets/upload-…/reference/…`；前端应加 `/v1.1`，可直接使用 `appUrl(image)`。旧资源路径继续兼容，资源校验限定当前镜和素材。设备间复制、复制前备份、删除与重启载入同时覆盖双图；SQLite 为权威时，恢复须恢复完整数据库与资源备份，不能仅覆盖遗留 `exhibition.json`。

分类最多 40 项且不能为空，标签最多 80 项且可为空；每项最多 20 字，不区分大小写去重。删除分类或标签前，须先从仍使用它们的素材中移除。

自定义皮肤使用独立图片处理流程，不沿用服装素材的上传尺寸限制；完整解码后转换为 WebP，超大边长缩至 WebP 支持范围。返回的 `settings.uiSkin` 包含 `image`、`width`、`height`、`bytes`。

## 密钥设置

| 方法 | 路径 | 请求体 | 成功响应 |
| --- | --- | --- | --- |
| GET | `M/credentials` | — | 200 `ExhibitionCredentialsStatus` |
| PUT | `M/credentials`，仅 HTTPS | `apiKey`、`region`、`expectedRevision` | 200 同上 |

`region` 为 `cn` 或 `global`。`apiKey` 由后台内嵌 HTTPS 表单填写，本文不提供凭证值。响应示例：

```json
{
  "configured": true,
  "source": "mirror",
  "revision": 1,
  "region": "global",
  "hasUnconfirmedSession": false,
  "editable": true,
  "perSessionLimit": 30
}
```

响应不返回 SK。HTTP 父页面只收到表单高度和保存成功状态。`editable=false` 时结束体验并处理未确认会话后重试；不要重写本地凭证文件绕过检查。

## 实时会话

| 方法 | 路径 | 请求体 | 成功响应 |
| --- | --- | --- | --- |
| GET | `M/live/status` | — | 200 `ExhibitionLiveStatus` |
| POST | `M/live/session` | 见下例 | 201 会话对象 + 临时 `token` + `model` |
| POST | `M/live/session/{sessionId}/reference` | `{ "deviceId": "screen_device_001", "lookId": "commute", "refImageUrl": "https://供应商上传地址/参考图.webp" }` | 200 会话对象 |
| POST | `M/live/session/{sessionId}/condition` | `deviceId`、`lookId`、`sessionNumber`、`generationNumber`、可选 `refImageUrl` | 200 更新后的会话，包含 `referenceVersion` |
| POST | `M/live/session/{sessionId}/condition/applied` | 同上，加 `referenceVersion` | 200 镜状态，确认当前素材已应用 |
| POST | `M/live/heartbeat` | `{ "deviceId": "screen_device_001", "sessionId": "会话 UUID" }` | 200 镜状态 |
| POST | `M/live/error` | `deviceId`、`lookId`、`sessionNumber`、`generationNumber`、`message`、可选 `reason`；已有会话时加 `sessionId` | 200 镜状态；按 `lifecycle` 区分恢复中或需要人工处理 |
| GET | `S` | — | 200 会话对象，更新供应商凭证状态 |
| POST | `S/link` | `{ "providerSessionId": "ums-供应商会话编号" }` | 200 会话对象 |
| POST | `S/first-frame` | `{ "firstFrameMs": 1234 }` | 200 会话对象 |
| POST | `S/stop` | `{}` | 200 已停止会话；无法确认撤销时返回错误 |

创建请求示例（`lookId`、`generationNumber`、`expectedRevision` 必须取刚读取的当前状态）：

```json
{
  "deviceId": "screen_device_001",
  "lookId": "commute",
  "generationNumber": 1,
  "expectedRevision": 13
}
```

`deviceId` 为本次页面/客户端占用标识，8–100 位字母、数字、下划线或连字符；与持久设备身份 `terminalId` 不同。镜已绑定实体终端时，还必须提交该设备的 `terminalId` 和 `terminalToken`。已绑定镜拒绝其他终端申请实时会话。

创建响应的主要字段（临时 token 仅本次签发返回，下例为占位值）：

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "status": "active",
  "sourceKind": "camera",
  "providerRegion": "global",
  "pointsLimit": 30,
  "expiresAt": "2026-10-12T02:02:00.000Z",
  "referenceAsset": "/assets/exhibition/commute-cutout.png",
  "refImageUrl": "",
  "referenceVersion": 0,
  "consumedCredits": 0,
  "token": "<本次返回的临时凭证>",
  "model": "x2.0"
}
```

正确调用顺序：

1. 进入镜端仅准备本地取景，用户点击开始后提交 `command.begin`；确认镜状态为 `generating`。
2. 下载当前素材的 `referenceImage`（旧单图素材回退 `image`，纯提示词素材跳过），再调用 `live/session` 申请临时凭证；同一生成代数仅创建一次。
3. 通过对应区域官方 SDK 上传参考图，将云端 HTTPS 链接提交给 `live/session/{id}/reference`。Free 的 `referenceKind=none` 跳过参考图上传和绑定；MoX 使用图片输入。
4. SDK 建立 RTC 后，调用 `S/link` 关联真实供应商会话；收到真实远端首帧后调用 `S/first-frame`。仅上报首帧才进入 `showcase`，`firstFrameMs` 范围 0–120000，从客户端开始准备本次体验计时，包含素材、凭证和 RTC 建连；不等于某次换装可见延迟。
5. 每 3 秒提交本地 `live/heartbeat`，单请求 4 秒超时。服务端占用在最后一次有效心跳后 20 秒到期；终端按请求发出时的单调时钟计算截止并预留 2 秒。租约到期、凭证到期或达到单段上限时先停止当前段；后续恢复须由服务端核对旧凭证停止与恢复条件。
6. 正在运行的兼容摄像头会话切换素材时，先提交 `command.switch`，在原会话调用 `condition`，用返回的参考图和提示词更新 SDK 条件；SDK 确认成功后提交 `condition/applied`。两次请求均带当前 `deviceId`、`lookId`、`sessionNumber`、`generationNumber`，确认请求再带 `referenceVersion`。旧素材的迟到请求返回 409，不替换最新选择；保持原 RTC、摄像头和临时凭证。MoX、模式改变或未连接会话继续走停止与重建流程。
7. 停止或离开时立即提交 `command.end` 或 `command.idle`，同时释放 SDK 和摄像头、对已创建会话调用 `S/stop`，不等待 SDK 清理才通知后台；本地结束与云端停止确认分别处理。

会话状态为 `reserved` / `active` / `stopping` / `stopped` / `issuance_unknown` / `error`。签发或停止状态未知时保留异常记录，不自动重复申请。`recover` 仅释放已结束的本地占用，不宣称未知云端凭证已撤销。

不限模式的健康会话由大屏主动计划续接，与前述 `live/error` 技术恢复分开处理；不能仅凭 SDK 错误或异常停止启动 `renewal` 计划：

1. 已收到真实首帧、当前素材已确认且会话仍为 active 时，凭证距到期 20 秒以内，或已核对消耗达到每段上限减 30 credits，允许 `POST M/live/session/{id}/renewal`，提交 `{ "deviceId": "…", "sessionNumber": 1, "generationNumber": 1 }`。成功返回 `{ "renewalId": "…" }`；`live.renewal` 显示这次计划，心跳返回的 `live.renewalDue` 可提示达到续接阈值。未确认使用量或客户端自报额度不构成续接依据。
2. 大屏停止旧 SDK 并调用 `S/stop`，服务端确认旧临时凭证 stopped 后，再 `POST M/live/session/{id}/renewal/commit`，提交 `{ "deviceId": "…", "renewalId": "…" }`。成功返回完整镜状态：原 `sessionNumber` 保留，`generationNumber` 加一，`phase=generating`、`live=null`，只允许原大屏申请下一段。重复成功提交不重复增加代数或签发凭证。
3. 计划有效期为 20 秒，且大屏心跳必须有效。续接中轮播与换装暂缓，手动结束/待机/暂停即时生效。计划失效或旧凭证停止未确认时，不提交下一段；新段签发失败不自动重复申请。返回 `paused` 或 `needs_assistance` 时，处理停止状态后手动继续；符合协议 2 的连接故障、已核对的到期或耗尽，通过 `live/error` 申请恢复。后台轮询不会释放有效计划的旧占用，也不会自行续接；服务重启不恢复计划。

智能镜不设置本地累计预算；`consumedCredits` 为单次临时凭证已核对消耗，不代表 SK 余额，余额不足以 XMAX 实际返回为准。单轮积分与凭证有效期默认 30 credits / 120 秒，可在后台按镜设置，或通过服务端环境配置缺省值；XMAX 仍可根据实际账号和服务限制拒绝签发。会话的 `pointsLimit` 保留签发时的积分上限，耗尽判断使用该快照。

## 错误处理

错误格式示例（HTTP 409）：

```json
{
  "error": {
    "code": "EXHIBITION_STALE_REVISION",
    "message": "屏幕状态已更新，请刷新后重试。"
  },
  "code": "EXHIBITION_STALE_REVISION",
  "message": "屏幕状态已更新，请刷新后重试。"
}
```

| 状态码 | 常见情况 | 前端处理 |
| --- | --- | --- |
| 400 / 415 | 无效字段、图片、JSON 或内容类型 | 显示 `message`，修正输入 |
| 403 | 来源/主机不允许、HTTP 写密钥、终端凭据不匹配 | 使用规定入口和已绑定设备；密钥通过内嵌 HTTPS 表单提交 |
| 404 | 镜/素材/会话不存在 | 重新读取设备列表和当前状态 |
| 409 | 状态版本变化、阶段不允许、会话归属不符、设备占用、停止待确认 | 刷新状态并核对；停止不确定时先处理旧会话 |
| 410 | 配对码过期 | 使用镜端最新配对码 |
| 413 | 请求体或图片过大 | 按当前限制重新选择图片 |
| 426 | 镜端未携带协议 2 标识 | 配套更新镜端后再开始体验 |
| 429 | 上传并发已满、配对尝试过多 | 等待后重试 |
| 500 / 502 / 503 | 存储、供应商、服务或凭证不可用 | 保留当前输入，显示简短反馈；不要自动重复签发 |

HTTP/HTTPS 网关拒绝请求时可能返回纯文本。调用方应检查响应类型，避免把网关错误当成成功 JSON。

## 提前准备参考素材

- `GET M/references` 批量返回 `{ references: { [lookId]: { state, message?, retryAt?, updatedAt?, freshUntil?, stage? } } }`，供工作人员后台显示状态。`state` 为 `queued`、`preparing`、`ready`、`failed`、`unconfigured` 或 `not_required`；时间字段为 Unix 毫秒。此接口不返回云端 URL、账号摘要或凭据，也不会触发上传。
- `POST M/references/{lookId}/retry`，JSON 请求体 `{}`，返回 HTTP 202 和 `{ status }`，异步准备该素材；已有任务复用，有效缓存不重传。失败后冷却期间仅返回当前状态，达到 `retryAt` 后可重试。原有同步准备接口保持兼容。
- `GET M/references/{lookId}` 只读查询，返回 `{ reference: null }` 或 `{ reference: { url, sha256, scope, freshUntil } }`。`scope` 为账号与区域的不可逆摘要；`freshUntil` 为 Unix 毫秒。查询不会签发临时 key 或发起云端上传。
- `POST M/references/{lookId}`，JSON 请求体 `{}`，准备指定素材并返回同一结构。仅使用该镜当前永久凭据向对应区域上传规范化后的参考图（旧单图素材回退展示图）并执行 SDK 同等的安全检查，不创建 RTC 或生成任务。图片仍保存在原素材目录。
- 后台启动后自动串行准备空闲镜的素材，顺序为当前选中、已启用、其他素材；同优先级在镜子与素材间轮换，新上传或选择变化在下一轮调度生效。失败任务冷却后排在尚待准备的任务之后重试，避免连续超时阻塞正常素材。同内容、MIME、账号、区域的结果跨体验和服务重启复用；内容或账号变化自然失效。有效记录保留 1 小时，临近到期以 HEAD 检查续期，明确不存在才重新上传；网络不确定时冷却 60 秒。
- 创建体验会话新增可选字段 `referenceScope`。客户端仅在它与准备结果 `scope` 相同且仍新鲜时复用 URL；缺字段、区域/账号变化、查找超时或未准备均回退普通 SDK 上传。现有 reference 绑定、session 关联和条件版本校验继续执行。
- 同时最多 2 个准备任务（自动任务最多 1 个）；变更等待最多 128 个连接，超额返回 429。断开请求自动清理订阅。
