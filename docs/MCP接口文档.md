# CyberBrick MCP 接口文档

| 项目 | 内容 |
|---|---|
| Server 名称 | `cyberbrick` |
| Server 版本 | `0.3.0` |
| 传输方式 | stdio（本地进程） |
| 协议 | MCP（JSON-RPC 2.0 over stdio） |
| 工具数量 | 41 |
| 上游依赖 | CyberBrick 桌面应用 v0.6.2，CDP `127.0.0.1:9223` |
| 文档版本 | 2026-10-24 |

---

## 1. 前置条件与约定

### 1.1 启动

```bash
npx -y cyberbrick-mcp        # stdio MCP server（本地检出：node src/server.js）
```

客户端配置：

```json
{ "mcpServers": { "cyberbrick": { "command": "npx", "args": ["-y", "cyberbrick-mcp"] } } }
```

前置：CyberBrick 应用已以 `--remote-debugging-port=9223` 启动（可用 `cb_launch` 代劳）；应用需在**非沙箱**终端启动（否则 Electron 沙箱初始化失败、进程秒退）。

### 1.2 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CB_CDP_HOST` | `127.0.0.1` | 必须 IPv4（`localhost` 可能解析到 `::1`） |
| `CB_CDP_PORT` | `9223` | CDP 端口 |
| `CB_APP_BINARY` | `/Applications/CyberBrick.app/Contents/MacOS/CyberBrick` | `cb_launch` 的可执行文件 |

### 1.3 核心约定

- **纯透传**：每个工具直接调用应用自身的 API（zustand store action / 设备方法），调用即执行，没有 MCP 侧的预览或 token。例外：会升级固件的调用（`flash_mpy`、`flash_firmware`、带 `hardwareMappings` 的 `flash_config`）必须传 `confirm: true`，且只在用户明确同意后设置；设备类写操作的 `target` 必须唯一匹配一台设备。
- **多窗口**：连接时自动选 `window.env.isPrimary === true` 的主窗口（子窗口会把所有设备调用转发失败）。
- **超时**：evaluate 硬超时 10s（长流程 60s）；设备命令 8s；`cb_launch` 等待 20s。
- **脱敏**：返回值经 `sanitize()`——key 匹配 `/token|auth|secret|passphrase|pin|aeskey|privatekey|cert/i` 的值替换为 `"<redacted>"`；字符串 >4000 字符截断。
- **响应**：成功为 JSON 文本；业务缺失（如 `DEVICE_NOT_FOUND`）`isError=false` 但响应体内含 `error` 字段——**调用方需检查 `error` 字段，不能只看 `isError`**；执行失败 `isError=true`、文本前缀 `ERROR: `。
- **BLE 掉线**：板子休眠/池清理会导致设备掉线，重跑 `connect_bluetooth` 即恢复（会刷新 `bluetoothDeviceId`，之后以 `device_list` 的新值为准）。`RECONNECTION_INTERRUPTED` 是 App 内并发建连互相打断（`connectionCount` 被改），常见于被杀掉的调用留下了挂起的 chooser——不必重启板子，重跑 `connect_bluetooth`（已内置 chooser 取消）即可；仅当板子确实不再广播时才需断电重启。

---

## 2. 工具总表（41 个）

### 基础设施（3）

| 工具 | 参数 | 说明 |
|---|---|---|
| `cb_health` | — | CDP 存活、App 版本、桥可达、设备数。**最先调用**。返回 `{status, appVersion, deviceCount, deviceNames, env, ...}`；不可达时 `{status:"unreachable", hint}` |
| `cb_launch` | `kill_existing=false`, `timeout_ms=20000` | 以调试端口拉起 App。CDP 已可达时直接复用（`alreadyRunning`）；App 已在跑但没开调试端口时报错，需用户同意后传 `kill_existing=true`（单实例锁，会丢未保存的工作）。返回 `{launched, pid, endpoint, version}`。**必须非沙箱 shell** |
| `app_logs` | `since=0`, `grep?`, `levels?`, `limit=200`, `includeNoise=false` | App 渲染进程控制台（server 挂上 CDP 起的环形缓冲，5000 行）。返回 `{lastSeq, returned, matched, lines[{seq, ts, level, text}]}`；下次传 `since=lastSeq` 增量跟踪 `flash_config`+`hardwareMappings` 这类长流程。逐条 B0 收发与 keepalive 默认隐藏；含 token/key/PIN/cert 的行**不入缓冲**。只读 |

### 设备（11）

| 工具 | 参数 | 说明 |
|---|---|---|
| `device_list` | — | 已知设备列表 `{deviceCount, devices[], displayNames}`。字段：`deviceName`/`deviceId`(MAC)/`bluetoothDeviceId`(推荐作为 device_id)/`deviceType`/`deviceConnectStatus`/`firmwareVersion`/`loaderVersion`/`snCode`/`hasBoardConfigFile` |
| `device_detail` | `device_id` | 单设备：连接态、loader 模式、连接池条目 `{deviceId, bluetoothDeviceId, name, connectStatus, deviceType, isInLoader, poolEntry}` |
| `device_pool_state` | — | 蓝牙连接池 `{poolSize, poolKeys, entries[]}`（真实位置 `bluetoothDeviceManager.bluetoothDevicePool`，按 MAC 键） |
| `device_request` | `method`, `args[]` | 只读调试入口：仅允许 `isInLoader`、`getDeviceById`，以及只读命令白名单内的 `sendGetMessage`（DEVICE_STATUS、GET_DEVICE_CONFIG、GET_BOARD_INFO、GET_BOARD_TYPE、GET_DEVICE_WIFI_MAC、SYSTEM_VERSION、MPY_PROJECT_INFO、MPY_CHECKSUM_INFO），其余一律拒绝 |
| `board_info` | `device_id` | B0 聚合（SYSTEM_VERSION+GET_BOARD_INFO+GET_BOARD_TYPE）：`{systemVersion, board, boardType, parsed:{firmware, loader, hardware, project, snCode, boardType, chipMac}}`。`chipMac` 来自 `GET_DEVICE_WIFI_MAC(10)`，是芯片基础 MAC，等于 USB 序列号（不同于 macOS 上的伪地址 deviceId） |
| `device_status` | `device_id` | ADC/通道状态向量 `DEVICE_STATUS(3)` → `{values[10]}` |
| `device_config_get` | `device_id` | 板载配置文件元信息（`GET_DEVICE_CONFIG {reqType:0}`）→ `{file_size, file_chunk_size, md5{16}}`；`file_size=0` 表示无板载配置 |
| `device_config_block` | `device_id`, `index` | 按块读取板载配置（`reqType:1`）；块数 = `ceil(file_size/file_chunk_size)`。`data` 是下标为键的对象，末块按 chunk 填充 |
| `device_config_read` | `device_id` | 整份回读：INFO + 全部块，按 `file_size` 截断 → `{fileSize, chunkSize, blocks, md5, configName, config}`。`md5` 与 `flash_config` 返回值直接比对（`device_config_get` 的 md5 字段不是文件摘要）。只读 |
| `device_ble_state` | — | 每个设备的实时 BLE 状态 `{storeStatus, managerStatus, gattConnected, isInLoader, connectionCount, connectionCountOk, inPool}`。`connectionCountOk:false` 时 App 的所有重连（升级进 loader、掉线）都会立即 `RECONNECTION_INTERRUPTED`。只读 |
| `device_ble_heal` | — | 把非有限的 `BluetoothDevice.connectionCount` 置 0（等同 App 的 `markBluetoothDevice`），免重启恢复重连能力；无 BLE I/O。返回 `{healed[{deviceId, was}], count}`。MUTATING（仅内存） |

### 连接（3）

| 工具 | 参数 | 说明 |
|---|---|---|
| `connect_scan_ports` | `includeKnownDevices=true` | 枚举已授权 Web Serial 端口与 Web Bluetooth 已知设备。只读，不配对 |
| `connect_bluetooth` | `deviceName?`, `deviceId?`, `timeoutMs=15000` | **真实添加设备**：BLE 扫描（厂商过滤 17882/前缀[99]）→ 免 UI 自动选中 → MAC 解析 → 入池 → B0 探测 → `addDevice` 入库。按名称找到的已知设备**全部**有活跃 GATT 链接时直接返回 `alreadyConnected`（板子连着时不广播，扫也扫不到；同名板子——如都叫 RC_MODULE——有一块离线就照常扫描）；选中后调 `markBluetoothDevice` 初始化 connectionCount；已知设备掉线重连时重新入池并更新 `bluetoothDeviceId`（`reconnected`）；扫描前先取消残留的 chooser。无设备广播时超时返回 `CHOOSER_CANCELLED`（附 hint）。`deviceId`（`device_list` 的 deviceId）直接比对选择器列表里的设备 id，优先于 `deviceName`：配对后板子改广播 `CyberBrick-[NNNN]`，店里存的名字仍是旧的（如 RC_MODULE），同名板子也只能靠它区分。注意 macOS 上这个 deviceId 是 Chromium 由 CoreBluetooth UUID 生成的伪地址，**不是芯片 MAC**（与 USB 序列号对不上）；App 的 `name-to-id` 映射以广播名为键，同名会互相覆盖 |
| `connect_serial` | — | 经 `window.electron.ipcRenderer.autoSelectSerialPort({strategy:'first'})` 让主进程选中 USB-C 串口，返回 `{selected:{portId, portName, displayName, vendorId, productId, serialNumber}, board}`：ESP32 的 serialNumber 就是芯片 MAC，与各蓝牙在线板子的 `chipMac` 比对后在 `board` 里给出对应的 `{deviceId, deviceName, deviceType, bluetoothDeviceId}`；对不上时 `board:null` 并附 `boardHint`（先 `connect_bluetooth`）。本 App 的串口只服务 USB 刷机（救砖）功能；配置、配对、升级等其余设备工具都只走蓝牙。不写板子 |

### 固件编写（6）

| 工具 | 参数 | 说明 |
|---|---|---|
| `firmware_config_get` | — | 编辑器当前配置 `{firmwareConfig, configType, hardwareMappings, isModified}`。这就是将被烧录的内容 |
| `firmware_edit_actions` | — | 编辑面枚举 + 60 个 store action 的语义化签名。`firmware_config_edit` 的 action/args 以此为准（`enums.actuator=[PWM1..4,LED1/2,MOTOR1/2,BUZZER1/2,CODE]`） |
| `firmware_config_set` | `config` | `setFirmwareConfig` 替换整个编辑器配置。MUTATING |
| `firmware_config_edit` | `action`, `args[]` | 调单个 store action（如 `updateReceiverChannel(receiverKey, actuator, channel)`、`changeSwitchState(i)`、`addHardwareMapping({hardwareKey, boardId})`）。立即生效。MUTATING |
| `firmware_config_load_template` | `template`, `keepIdentity=true` | 用内置模板（同 `project_create` 的枚举与数据，按 App 语言取 en/cn）替换编辑器配置。默认保留当前项目 id/名称，`project_save` 即覆盖该项目；`false` 则作为未保存的新配置。标记 isModified，不写列表/板子。MUTATING |
| `firmware_config_reset` | — | 清空为默认。MUTATING |

### 烧录（5）

| 工具 | 参数 | 说明 |
|---|---|---|
| `flash_config` | `target?`, `firmwareConfig?`, `hardwareMappings?`, `firmwareListId?`, `confirm?` | 写板载配置。默认走 App 的 `SET_DEVICE_CONFIG` 文件协议（`sendGetMessage` command 5：FILE_INFO(md5,size) → 分块 FILE_BLOCK，chunk 由板子返回，实测 150）——**真机验证过**，不要求 sender，单接收器可用。烧 `firmwareConfig`（传入时）否则烧当前编辑器配置，内容为 `JSON.stringify({...config, version:"2"})`，MD5 在 Node 侧计算。设备按 `target` 选，只能给一个字段且必须唯一匹配（不传时 App 里必须只有一台设备），否则 `AMBIGUOUS_TARGET` / `DEVICE_NOT_FOUND`；未连接返回 `{stage:"RESOLVE_DEVICE", error:"DEVICE_NOT_CONNECTED"}`（先 `connect_bluetooth`）。写完回读 GET_DEVICE_CONFIG，成功返回 `{ok, verified, bytes, chunkSize, blocks, md5, readback, device}`（`verified` = 板子报告的大小与写入一致），失败返回 `{stage: RESOLVE_DEVICE\|CONFIG\|FILE_INFO\|FILE_BLOCK, ...}`。**仅当显式传 `hardwareMappings`** 才走高层 `runSendConfigTask`：烧已保存项目 `firmwareListId`（缺省为编辑器当前 config id，须存在于 `project_list`，否则 `FIRMWARE_LIST_ID_NOT_FOUND`），finalMode 硬编码要求 sender；此路径不接受 `firmwareConfig`，**不会新建项目**；缺省用编辑器项目且有未保存修改时返回 `UNSAVED_CHANGES`；此路径可能先升级固件/MPY/loader，须先 `flash_check` 给用户看并传 `confirm: true`。MUTATING |
| `flash_check` | `hardwareMappings`, `firmwareListId?` | `hardwareMappings` 烧录的升级预检（App 的 `checkDeviceConfigSync`）：`{upgradeCheckResult:{upgradeTargets[{deviceId, checkResult:{shouldUpgradeFirmware, shouldUpgradeMpy, shouldUpgradeLoader*, upgradeFirmwareTo, upgradeMpyTo, upgradeLoaderTo}}], firmwareInfo, loaderInfo}, needsSendConfig}`。不写板子。`upgradeTargets` 就是实际会执行的升级——App 日志里可能出现 `shouldUpgradeLoader: true`，但运行时仍会"不升级 Loader"，以返回值为准（真机：sender 0.0.0.0/loader 中 → 固件 1.1.4.13 + MPY，loader 保持 99.0.2.51）。只读 |
| `flash_mpy` ⚠️ | `confirm: true`, `target?`, `mpyType=1`, `designId?`, `region?`, `checksum0?`, `userMpyConfig?`, `eraseFirmwareConfig=false` | MicroPython 更新（`updateLoaderFirmwareMpy`，唯一公开入口）：写 mpy.img 并重启板子。`mpyType: 0=user_mpy（需 userMpyConfig）/1=cb_rc（内置）`。**实验性**（内置路径待真机验证）。缺 `confirm: true` 时拒绝。DESTRUCTIVE |
| `flash_firmware` ⚠️ | `confirm: true`, `target?`, `firmwareBinaryB64`, `targetVersion?`, `region?` | 系统升级（SYSTEM_UPGRADE，loader 模式）。多次重启、**中断可砖**。必须传固件 .bin 的 base64——MCP 不复刻 App 的云端取包（签名+证书解密）。错误：`FIRMWARE_BINARY_REQUIRED`；缺 `confirm: true` 时拒绝。DESTRUCTIVE |
| `flash_test` | `target?`, `command` | `sendTestCommand` 驱动执行器。`target` 规则同 `flash_config`；`command = {actuator, set_value, receiver, data}`，`deviceId` 只取自 `target`（actuator 见 `firmware_edit_actions`）。MUTATING |

`target` = `{bluetoothDeviceId | deviceIndex | deviceName}`，缺省取 `device_list` 第一个设备。

### 项目管理（13）

项目存储 = `useFirmwareListStore`（zustand persist，key `firmware-list-storage`）。

| 工具 | 参数 | 说明 |
|---|---|---|
| `project_state` | — | **渐进披露地基，最先调用**：当前路由 hash、page（projects/project_edit/devices/settings）、项目列表、编辑器状态、`nextTools[]`（当前上下文有意义的工具清单） |
| `project_list` | `id?` | 列表 `{count, projects:[{configId, type, configName, designLink, lastModifiedTime}]}`；传 `id` 返回单条完整记录 |
| `project_create` | `template`, `name?` | 从内置模板建项目。模板：`forklift`/`truck`/`forklift_and_truck`/`ball_car`/`official_remote`/`custom`（JSON 与 App 的 `createProjectFromTemplate` 逐字节一致）。MUTATING |
| `project_import` | `content`, `name?` | 导入项目 JSON（与 App 同语义：`config_version>2` 拒绝、强制 `design_id=0…0`/`region=xx`、按 zod schema 补齐骨架）。MUTATING |
| `project_export` | `id` | 导出项目 JSON 文本（裸字符串，剥离运行时字段，`version:"2"`）。只读，不弹窗 |
| `project_rename` | `id`, `name≤31` | 重命名。MUTATING |
| `project_delete` ⚠️ | `id` | **永久删除，不可恢复**，无 MCP 侧确认。DESTRUCTIVE |
| `project_load` | `id` | 载入编辑器（`setFirmwareConfig(getFirmwareById(id))`）。MUTATING。错误：`PROJECT_NOT_FOUND`、`DESIGN_NOT_EDITABLE` |
| `project_save` | — | 编辑器配置写回项目列表（`updateFirmware`：按 id 更新，无则新增）+ `markAsSaved`。MUTATING。错误：`NO_EDITOR_CONFIG` |
| `project_open_editor` | `id`, `target="new"\|"current"` | 载入配置（`configType=software`，否则编辑区为空白）并打开 `/project/edit`（新窗口 = `createWindowWithPath`；current = 主窗口 `history.pushState` 切 hash 路由，用户能实时看到后续 `firmware_config_edit` 的改动）。MUTATING（会开窗口） |
| `window_list` | — | 打开的 App 窗口清单：`openWindows`（CDP 实时：title+hash）、`storeWindows`（持久化 id 映射，可能滞后）、`currentWindowId`、`editorModified`。只读 |
| `window_close` | `windowId` | 关闭指定子窗口（App 的 `closeSubWindow` → `window:close-sub-window` IPC，与点关闭按钮同路径；未保存修改会弹 App 自带确认框，MCP 不绕过）。拒绝关当前连接窗口（`REFUSE_CLOSE_CURRENT`） |
| `window_close_others` | — | 关闭除当前连接窗口外的所有子窗口（清理 `project_open_editor` 积累的编辑器窗口）。MUTATING |

---

## 3. 典型调用链

```
cb_health → device_list（取 bluetoothDeviceId）
  ├─ board_info / device_status / device_config_get（只读探测）
  ├─ 设备未连接 → connect_bluetooth（自动扫描+选中+入库）
  │
  └─ 完整开发循环：
     project_state → project_list → project_load → firmware_config_edit（签名查 firmware_edit_actions）
     → project_save → flash_config → device_config_read（md5 比对）

  └─ 发送端 + 接收器烧录并配对（runSendConfigTask）：
     device_ble_state（connectionCountOk 为 false → device_ble_heal）
     → flash_check（升级项先征得用户同意）
     → flash_config{hardwareMappings, firmwareListId}（并行轮询 app_logs since=lastSeq 看进度）
     → board_info（版本）→ device_config_read（两块板）
```

---

## 4. 错误参考

| 标识 | 含义 | 处理 |
|---|---|---|
| `NO_APP_MANAGER` | `window.app` 不可达 | `cb_health`，确认页面已加载 |
| `CONFIRMATION_REQUIRED` | 升级类调用缺 `confirm: true` | 向用户说明影响（`flash_check` 可预览），同意后再带 `confirm: true` 调用 |
| `AMBIGUOUS_TARGET` | `target` 给了多个字段，或匹配到多台（含同名板子），或不传 target 而 App 里有多台设备 | 用 `device_list` 的 `deviceId` 指定 |
| `DEVICE_NOT_FOUND` | 标识无效或设备已移除/掉线 | 重连（`connect_bluetooth`）后重新 `device_list` |
| `PROJECT_NOT_FOUND` / `DESIGN_NOT_EDITABLE` | 项目 id 无效 / design 类型不可编辑 | `project_list` 取有效 id |
| `NO_EDITOR_CONFIG` | 编辑器无配置 | 先 `project_load` 或 `firmware_config_set` |
| `config_version_unsupported` | 导入文件版本 > 2 | 用当前版本 App 重新导出 |
| `FIRMWARE_BINARY_REQUIRED` | `flash_firmware` 未传二进制 | 提供 .bin 的 base64 |
| `RECONNECTION_INTERRUPTED` | 设备 connectionCount 为 NaN，App 重连检查恒失败 | `device_ble_state` 确认后 `device_ble_heal`，无需重启板子 |
| `CHOOSER_CANCELLED` | BLE 扫描超时无设备 | 板子是否上电广播；OS 残留 GATT 链接时重启板子 |
| `INVALID_TEMPLATE` / `UNKNOWN_TEMPLATE` | 模板键不合法 | 见 `project_create` 的枚举 |
| `EVALUATE_TIMEOUT` | renderer 10s 未响应（用户正在操作编辑器等） | 重试；长流程工具内部已用 60s |
| `ERROR: JS evaluation error: …` | 应用内执行抛错 | 检查方法名/参数；确认 App 版本 |
| `LAUNCH_FAILED: …` | 启动失败（二进制不存在/秒退/端口未就绪） | 非沙箱 shell 重试 |
| `CDP connection failed after 5 attempts` | 端口不可达或无渲染目标 | 先 `cb_launch` |

---

## 5. 协议约束（安全红线）

- **只读白名单**：`sendReadCommand` 仅允许 8 条 B0 命令（DEVICE_STATUS=3、GET_DEVICE_CONFIG=4、GET_DEVICE_WIFI_MAC=10、GET_BOARD_INFO=11、GET_BOARD_TYPE=16、MPY_PROJECT_INFO=21、MPY_CHECKSUM_INFO=22、SYSTEM_VERSION=259），其余在发送前抛错。
- **故意不暴露**：BIND_DEVICE(0)、UNBIND_DEVICE(1)、SET_PIN_CODE(7)、SET_DEVICE_NAME(8)、SET_PRIVATE_KEY(12)、证书流程、PIN 流程。
- **不读取/导出** auth token、私钥、AES key（`sanitize()` 按 key 名过滤；云端签名头 `getBBLHeader` 不使用）。
- **MPY/系统升级的云端路径**（`getPackageInfo` → 加密 URL → RSA 解密 → 下载）由 App 自身完成；MCP 侧不触碰。详见 `docs/MPY固件链路笔记.md`。
