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
- 常规 JSON 请求上限 16 KiB，密钥写入上限 2 KiB；素材上传按当前设置单独计算限制。
- 状态写入建议携带最新 `expectedRevision`。409 `EXHIBITION_STALE_REVISION` 时重新读取状态、核对操作后再提交。密钥有独立的 `revision`，不能使用镜状态版本代替。
- `updatedAt`、`boundAt`、`expiresAt`（配对码）等数字时间为 Unix 毫秒；会话中的 `createdAt`、`updatedAt`、`expiresAt` 为 ISO 时间字符串。

## 设备与绑定

| 方法 | 路径 | 请求体 | 成功响应 |
| --- | --- | --- | --- |
| GET | `/v1.1/api/exhibition/mirrors` | — | 200 `ExhibitionMirrorList` |
| POST | `/v1.1/api/exhibition/mirrors` | `{ "name": "右侧智能镜" }` | 201 `ExhibitionMirrorSummary` |
| PATCH | `M` | `{ "name": "入口智能镜" }` | 200 `ExhibitionMirrorSummary` |
| GET | `M` | — | 200 `ExhibitionState` |
| POST | `M/copy` | `{ "sourceMirrorId": "default", "copyLooks": true, "copySettings": true, "expectedRevision": 12 }` | 200 目标镜状态 |
| GET | `/v1.1/api/exhibition/native-identity` | — | 200 `{ "native": false }` |
| POST | `/v1.1/api/exhibition/terminals/connect` | 见下例 | 200 `ExhibitionDeviceConnection` |
| POST | `M/binding` | `{ "code": "123456" }` | 200 `ExhibitionDeviceBinding` |
| DELETE | `M/binding` | `{ "terminalId": "terminal-…" }` | 200 `{ "binding": null }` |

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
  "code": "123456",
  "expiresAt": 1791771000000
}
```

绑定后同一请求返回 `mirrorId` 和 `mirrorName`，不再返回配对码。配对码有效期 10 分钟、使用一次后失效；镜端每 10 秒连接刷新在线状态，30 秒未连接视为离线。API 接受 32–512 位可见 ASCII 的设备 `token`；本包浏览器生成并保存 64 位随机十六进制值，服务端仅保存其哈希。已登记设备使用错误 token 返回 403。修改绑定要求镜处于 `idle` 或 `select`，且无实时会话。

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
| `settings` | 上传限制、自动返回、轮播和皮肤设置 |
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
| `confirm` | — | 仅旧客户端 `positioning` 阶段兼容 |
| `switch` | `lookId` | `showcase`，换到指定已启用素材 |
| `next` / `previous` | — | `showcase`，按素材顺序循环 |
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
| `uploadLimits` | 下面的完整限制对象 |

默认上传限制：

```json
{
  "maxFileSizeMB": 10,
  "minWidth": 512,
  "maxWidth": 4096,
  "minHeight": 512,
  "maxHeight": 4096
}
```

可配置文件上限 1–20 MiB；各宽高范围 64–8192 px，最小值不能超过最大值，总像素不超过 3200 万。

## 素材、分类与皮肤

| 方法 | 路径 | 请求体 | 成功响应 |
| --- | --- | --- | --- |
| POST | `M/looks` | 素材元信息 + `imageBase64` | 201 完整镜状态 |
| PATCH | `M/looks/{lookId}` | 要修改的元信息 + `expectedRevision` | 200 完整镜状态 |
| DELETE | `M/looks/{lookId}` | `{ "expectedRevision": 12 }` | 200 完整镜状态 |
| GET / HEAD | `M/assets/{uploadId}` | — | 200 `image/webp` |
| POST | `M/taxonomy` | `{ "categories": ["通勤", "休闲", "礼服"], "tags": ["简约", "日常", "优雅"], "expectedRevision": 12 }` | 200 完整镜状态 |
| POST | `M/skin` | `{ "imageBase64": "…", "expectedRevision": 12 }` | 200 完整镜状态 |
| DELETE | `M/skin` | `{ "expectedRevision": 12 }` | 200 完整镜状态，恢复默认皮肤 |
| GET / HEAD | `M/skin/{skinId}` | — | 200 `image/webp` |

素材上传 JSON 示例，`imageBase64` 应换成完整图片的 base64 或 data URL：

```json
{
  "name": "藏蓝西装",
  "description": "日常通勤",
  "mode": "clothx",
  "category": "通勤",
  "tags": ["简约"],
  "imageBase64": "data:image/png;base64,<完整图片编码>"
}
```

名称 1–40 字，描述最多 120 字，每份素材最多 8 个标签；分类和标签必须已登记。只接受可完整解码的静态 PNG/JPEG/WebP，统一转为 WebP。每镜最多 100 份素材，全服务同时处理最多 2 份上传。新增素材默认禁用，需通过 `configure.enabledLookIds` 启用。上传可在体验中追加，不使用全局版本锁；编辑、删除、分类调整和皮肤更换需先结束体验。

Free 模式必须提交 1–1000 字 `prompt`；`referenceKind: "none"` 表示仅使用提示词，上传图只作为封面。其他模式仅支持图片参考。返回的素材 `image`、皮肤 `image` 为版本相对路径，如 `/api/exhibition/mirrors/default/assets/upload-…`；前端应加 `/v1.1`，可直接使用 `appUrl(image)`。

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
| POST | `M/live/heartbeat` | `{ "deviceId": "screen_device_001", "sessionId": "会话 UUID" }` | 200 镜状态 |
| POST | `M/live/error` | `deviceId`、`lookId`、`sessionNumber`、`generationNumber`、`message`；已有会话时加 `sessionId` | 200 暂停后的镜状态 |
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
2. 下载当前素材，再调用 `live/session` 申请临时凭证；同一生成代数仅创建一次。
3. 通过对应区域官方 SDK 上传参考图，将云端 HTTPS 链接提交给 `live/session/{id}/reference`。Free 的 `referenceKind=none` 跳过参考图上传和绑定；MoX 使用图片输入。
4. SDK 建立 RTC 后，调用 `S/link` 关联真实供应商会话；收到真实远端首帧后调用 `S/first-frame`。仅上报首帧才进入 `showcase`，`firstFrameMs` 范围 0–120000。
5. 每 5 秒提交本地 `live/heartbeat`。超过 15 秒未收到心跳、有效期结束或达到单次上限时，服务端尝试停止并释放占用。
6. 停止/切换/离开时释放 SDK 和摄像头，提交 `command.end` 或 `command.idle`，并对已创建会话调用 `S/stop`；以服务端停止确认完成为准。

会话状态为 `reserved` / `active` / `stopping` / `stopped` / `issuance_unknown` / `error`。签发或停止状态未知时保留异常记录，不自动重复申请。`recover` 仅释放已结束的本地占用，不宣称未知云端凭证已撤销。

智能镜不设置本地累计预算；`consumedCredits` 为单次临时凭证已核对消耗，不代表 SK 余额，余额不足以 XMAX 实际返回为准。默认单次最多 30 credits、有效期最多 120 秒，可在服务端环境配置降低。

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
| 429 | 上传并发已满、配对尝试过多 | 等待后重试 |
| 500 / 502 / 503 | 存储、供应商、服务或凭证不可用 | 保留当前输入，显示简短反馈；不要自动重复签发 |

HTTP/HTTPS 网关拒绝请求时可能返回纯文本。调用方应检查响应类型，避免把网关错误当成成功 JSON。
