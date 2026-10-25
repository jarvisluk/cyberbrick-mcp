# MPY / 固件升级链路 — bundle 逆向笔记（2026-10-24）

> 供 MCP 实现 `flash_mpy` / `flash_firmware` 时参考。来源：`index-C-WvfsRp.js`（CyberBrick 0.6.2）+ 真机核对。

## 0. 结论速览

| 事项 | 结论 |
|---|---|
| 高层入口 | `window.app.local.updateLoaderFirmwareMpy(payload)` —— 唯一公开入口，内部完成全部流程 |
| payload | `{deviceId, currentBoardIndex, mpyType, designId, region, userMpyConfig, files:{firmware, loader}, checkResult, eraseFirmwareConfig}` |
| checkResult | 由 `t4e({deviceId, region})` 产出：`getPackageInfo(Firmware/Loader)` → `L7(...)` 比对 → `O7()` 修正；结构 `{shouldUpgradeLoaderBeforeFirmware, shouldUpgradeFirmware, shouldUpgradeLoaderAfterFirmware, shouldUpgradeMpy, upgradeLoaderTo, upgradeFirmwareTo, upgradeMpyTo, upgradeOrderSwitchable}` |
| 固件二进制 | `files.firmware` / `files.loader` = `fetch(packageInfo.downloadUrl)` 的 `arrayBuffer`（云端加密包 → RSA 私钥解密得真实 URL → 直接 fetch） |
| 内置 MPY | `default_rc_mpy_v01.00.01.01-CZQ9MEBn.img`（28604 字节，`RDHT` 容器头），checksum0 `FI="77d91d3ffc76dd34fd1518b786327180"`，文件名 `Ny="default_rc_mpy"` |
| MPY 二进制来源 | ① 内置 RC：上面那个 .img；② 用户 MPY：makerworld 授权 URL（designId+uniKey+serialNumber）下载拼接 |
| 写入分两步 | `c.writeBoardMpyInfo(btid, fileName, bytes)` → `c.startMpyUpgrade(btid, checksum0, designId, region)`（START_MPY_UPDATE，板子重启） |
| 前置 | `MPY_DEV_MODE {opt:0, mode:0}` 查询设备加密方式；`isInLoader` 判断；失败重试 enterLoader |
| eraseFirmwareConfig | true 时以 `M7(JSON.stringify(w4e), device, {hardware_name:"cb_rc"})` 抹除板载 RC 配置 |

## 1. 云端包信息（getPackageInfo）

```
GET {base}/v1/iot-service/api/rc/version?version=latest[&pkgType=Loader]
headers: getBBLHeader()          ← 云签名，MCP 红线：不要自己调
resp: { currentVersion, downloadUrl(加密), description }
解密: A_e(downloadUrl, appCert.privateKey) → 明文 URL → fetch(arrayBuffer)
```

- 包类型枚举 `Gn`: `Firmware` / `Loader` / `RcMpy("cb_mpy_rc")` / `TimelapseMpy("cb_mpy_timelapse")`
- 内置兜底版本：firmware `Dg="01.01.04.13"`（ap-es3_rev0-v01.01.04.13….bin），loader `kg="99.00.02.62"`（loader_rev0-v99.00.02.62….bin）
- **这些走云端 + 证书 + BBL 签名头，MCP 不复刻；要用时让 App 自己的 `updateLoaderFirmwareMpy` 去做**

## 2. mpyType 枚举（Rn）

- `user_mpy = 0`（用户项目 MPY，需 userMpyConfig）
- `cb_rc = 1`（内置 RC）

## 3. C4e（updateLoaderFirmwareMpy 实现）流程序号

1. 取设备（`getDeviceById(deviceId)`，无则 DEVICE_NOT_FOUND）
2. `SYSTEM_VERSION {submodule:1}` 读当前 fw/loader 版本 → checkResult 决定是否升级
3. `enterLoader`（未在 loader 时；失败重试一次，仍失败抛 `ENTER_LOADER_FAIL`）
4. `MPY_DEV_MODE {opt:0, mode:0}`（用户 MPY 时）
5-9. 用户 MPY：makerworld 授权 → 下载 → 拼 `{fileName, content}` 存 `mpyMap`
10. `writeBoardMpyInfo(btid, fileName, mpyBytes)` → `startMpyUpgrade(btid, checksum0, designId, region)` → 板子重启
12. `updateBoardInfo({deviceId})` 刷新设备信息
13. `eraseFirmwareConfig && M7(w4e, device)` 抹除 RC 配置（w4e = 空模板）

## 4. 单板独立升级（不走 RC 上传流程）

`fX({deviceId, deviceName, checkResult, firmwareInfo, loaderInfo, region, displayMode})`
→ `UC({upgradeTargets:[{deviceId, deviceName, checkResult, mpyType:Rn.cb_rc}], firmwareInfo, loaderInfo, region, designId:"0", eraseFirmwareConfig:false})`

UC 内部对每台设备：
```
b = {deviceId, currentBoardIndex, mpyType, designId, region, userMpyConfig,
     files:{firmware, loader}, checkResult, eraseFirmwareConfig}
按需 fetch 二进制 → it.getInstance().updateLoaderFirmwareMpy(b)
```

## 5. MCP 工具映射建议（纯透传）

- `flash_mpy` / `flash_firmware` 的正确底层 = `window.app.local.updateLoaderFirmwareMpy(payload)`（已在 `local` 原型上，len=1）
- payload 中 `checkResult` + `files` 必须真实；MCP 无法自己产出（云端/证书），因此：
  - 简单路径：透传一个「让 App 自己算 checkResult + 下载」的入口 = **没有**（t4e 是模块内部函数）
  - 可行路径：`updateLoaderFirmwareMpy` 接收的 payload 若 `checkResult.shouldUpgrade*` 全 false 且 `files` 为空 → 什么也不做。所以要么 (a) 用 App UI 触发升级，要么 (b) MCP 自带 .img 字节 + 手工构造 checkResult（shouldUpgradeMpy=true，upgradeMpyTo=内置 checksum）——`files.firmware/loader` 传 `new Uint8Array(0)`，但 enterLoader 需要 defaultFirmware……**未验证**，标注为待真机实验
- 内置 MPY .img 字节可从 asar 提取目录读（`renderer/main_window/assets/*.img`，RDHT 容器，28604B）

## 6. 版本语义（config version）

- `OI = 2`（当前支持的最高 config version）
- `Ud(config)`: `version > OI` → 拒载并弹升级对话框；`version === undefined/null` → 视为可载
- `SC(config)` = `{...config, version: String(OI)}` —— 导出/烧录前统一写 `version: "2"`
- 真机实测：传 `version: String(2)` 烧录成功
