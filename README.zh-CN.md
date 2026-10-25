# cyberbrick-mcp

[English](README.md) | 简体中文

MCP 桥接 Bambu Lab CyberBrick 桌面应用（Electron），通过 Chrome DevTools Protocol 驱动。

覆盖硬件连接规划 → 固件编写 → 烧录的完整流程。

## 状态

- 接口文档：[`docs/MCP接口文档.md`](docs/MCP接口文档.md)（工具契约、参数与响应、错误语义、协议约束）。
- 架构选型、App 内部入口、协议要点、踩坑与升级检查清单：[`docs/设计与踩坑笔记.md`](docs/设计与踩坑笔记.md)。

### 工具清单（41 个）

> 本 server 是 CyberBrick 应用的**纯透传层**：每个工具直接调用应用自身的 API（store action / 设备方法），调用即执行。例外：`flash_mpy`、`flash_firmware` 和带 `hardwareMappings` 的 `flash_config`（会先升级固件）必须传 `confirm: true`（用户明确同意后才设）；设备类写操作的 `target` 必须唯一匹配一台设备，否则拒绝执行。

**只读 / 探测（`readOnlyHint: true`）**
- 基础设施：`cb_health`、`app_logs`（App 控制台日志，跟踪升级/配对等长流程）
- 设备：`device_list`、`device_detail`、`board_info`、`device_status`、`device_config_get`、`device_config_block`、`device_config_read`（整份回读 + MD5）、`device_ble_state`（GATT / connectionCount 实时状态）、`device_pool_state`、`device_request`
- 连接规划：`connect_scan_ports`
- 烧录预检：`flash_check`（`hardwareMappings` 烧录会触发哪些固件/MPY/loader 升级）
- 固件读取：`firmware_config_get`、`firmware_edit_actions`（60 个 action 的语义化参数文档）
- 项目读取：`project_state`（页面感知 + nextTools 渐进披露）、`project_list`、`project_export`

**写入 / 烧录（直接执行，MUTATING）**
- 启动：`cb_launch`（App 未开调试端口时需 `kill_existing: true` 才会结束它）
- 连接：`connect_bluetooth`、`connect_serial`、`device_ble_heal`（修复 NaN connectionCount，免重启恢复重连）
- 固件编写：`firmware_config_set`、`firmware_config_edit`、`firmware_config_reset`、`firmware_config_load_template`（把内置模板套进编辑器）
- 烧录：`flash_config`（默认走 `SET_DEVICE_CONFIG` 文件协议，单接收器可用，不新建项目）、`flash_mpy`（`destructiveHint: true`）、`flash_firmware`（`destructiveHint: true`）、`flash_test`
- 项目管理：`project_create`（6 种内置模板）、`project_import`、`project_rename`、`project_delete`（`destructiveHint: true`）、`project_load`、`project_save`、`project_open_editor`
- 窗口：`window_list`（只读）、`window_close`、`window_close_others`

### 验证脚本
- 单元测试（不需要 App / 真机）：`npm test`
- 发布版本校验：`node scripts/check_release.mjs [vX.Y.Z]`
- 只读链路：`node scripts/verify_readonly.mjs`
- 服务与工具注册：`node scripts/mcp_list.mjs`
- 本地冒烟（需运行中的 App）：`node scripts/smoke.js`
- 项目管理冒烟（创建→改名→导出→导入→加载→保存→删除）：`node scripts/smoke_project.mjs`
- 项目管理 MCP E2E：`node scripts/mcp_e2e_project.mjs`
- 遥控小车端到端示例（发送端+接收端映射 → 保存 → 回读断言 → 导出；`--flash` 追加烧录与 LED 测试）：`node scripts/demo_rc_car.mjs`
- 临时调用任意工具：`node scripts/mcp_call.mjs <tool> '<json>' [...]`
- 模板数据再提取（App 升级后）：`python3 scripts/extract_templates.py`

## 运行

需要 Node.js 18+，且 CyberBrick 桌面应用在同一台机器上。

MCP 客户端配置（从 npm 安装）：

```json
{
  "command": "npx",
  "args": ["-y", "cyberbrick-mcp"]
}
```

从本地源码运行：

```bash
npm install
node src/server.js        # stdio MCP server
```

## CDP 端口

默认 `127.0.0.1:9223`（避开常用的 9222）。可用 `CB_CDP_HOST` / `CB_CDP_PORT` 覆盖。`cb_launch` 默认启动 `/Applications/CyberBrick.app/Contents/MacOS/CyberBrick`，可用 `CB_APP_BINARY` 覆盖。

## 安全红线

- 不读取 / 导出 auth token、私钥、AES key（`connection.js` 的 `sanitize` 会按 key 名过滤）。
- 破坏性工具（`flash_mpy`、`flash_firmware`）标注 `destructiveHint`，且必须传 `confirm: true`——Agent 先向用户转述影响（写板子 / 重启 / 可砖）并获得同意。
- `device_request` 只允许只读方法（`isInLoader`、`getDeviceById`，以及只读命令白名单内的 `sendGetMessage`）。
- `cb_launch` 默认不结束已运行的 App（会丢未保存的工作），需显式 `kill_existing: true`。
- 故意不暴露：BIND_DEVICE、SET_PRIVATE_KEY、证书流程、PIN 流程（见 `src/core/devices.js` 的 `ALLOWED_COMMANDS`）。

## 发布

CI（`.github/workflows/ci.yml`）在每次推送到 `main` 和每个 PR 时运行：在 Node 18/20/22/24 上跑测试、检查服务能否启动、校验版本号，并执行 `npm pack --dry-run`。

推送 `vX.Y.Z` 标签会触发 `.github/workflows/release.yml`：校验 → 发布到 npm（带 provenance）→ 把 `server.json` 发布到 MCP Registry → 用 CHANGELOG 对应段落创建 GitHub Release。每一步发现该版本已发布就会跳过，所以失败后直接重跑即可。

1. 更新版本号：`package.json` / `package-lock.json`（`npm version X.Y.Z --no-git-tag-version`）、`server.json`（两处 `version`）和 `src/server.js`。
2. 在 `CHANGELOG.md` 加一段 `## [X.Y.Z] - YYYY-MM-DD`。
3. 运行 `node scripts/check_release.mjs vX.Y.Z`，必须通过。
4. 提交后执行 `git tag vX.Y.Z && git push origin main vX.Y.Z`。

带后缀的标签（如 `v1.0.0-rc.1`）会以 npm 的 `next` dist-tag 发布，并标记为预发布（pre-release）。

一次性设置：
- **npm**：在 npmjs.com 上为这个包添加受信任发布者（Trusted Publisher）：GitHub Actions、工作流 `release.yml`、环境 `release`。包必须已经存在才能配置，所以第一次发布要么手动发一次，要么添加仓库 secret `NPM_TOKEN`（npm 自动化令牌）；启用受信任发布后删掉这个 secret。
- **MCP Registry**：无需配置。工作流用 GitHub OIDC 登录，对所在仓库的 `io.github.<owner>/` 命名空间有效。

## 许可证

[MIT](LICENSE)
