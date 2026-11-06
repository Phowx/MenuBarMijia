# macOS 明确设备控制版验证记录

日期：2026-11-06。起始提交：`5a77b9b`。范围见 ADR-0010。

## 原始提交基线

通过 `git archive HEAD` 将未修改的提交解包到 `/tmp/menubarmijia-original`，在那里运行原有 `scripts/check.sh`。未改动项目签名、系统默认 Xcode 选择或真实设备配置。

环境：Apple Silicon，完整 Xcode 27.2（27B52），通过 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` 使用。系统默认 `xcode-select` 指向 Command Line Tools；直接使用默认工具链时 SnapshotTesting 无法导入 XCTest，此为修改前可复现的环境问题。

使用完整 Xcode 的原始提交结果：

- 核心 361 项测试通过。
- App 62 项测试中仅截图测试失败，共 32 处 reference 不匹配；原生交互测试未报告失败。
- 原始日志：`/tmp/menubarmijia-original-check.log`，临时目录仅作本机验证证据。

## 变更验证

- 原有语言、模型、习惯、推荐、情绪球的 Swift 测试随功能删除；MIoT、区域、设备控制、历史、凭据、系统自动化和原生交互测试保留。
- 跨连接上下文的过期动作/撤销测试改用结构化动作入口，仍验证旧请求不能影响新家庭。
- 新增：未来和过期旧定时均不执行、原始数据跨启动保留、损坏数据保留、手动清理；只清理助手账户、共享 vault 不可读时不写入；动作失败回滚、撤销失败反馈；长按/重复全局热键无录音或额外动作。
- 截图已检查主面板、浅/深色、单/双列、展开卡片、设置各页、英文和宽窗口，以及新增旧定时清理区。面板没有助手按钮或情绪球，设置只有五个分类。
- 旧版 32 张截图在本机环境均已失败；本轮删除两个已不存在的助手设置截图，新增旧定时截图。检查当前 31 张画面后，将基线更新为本机 Xcode 27.2/macOS 渲染。没有通过放宽像素容差或跳过断言来消除差异。
- 设备未连接真实家庭，本轮不代表小米扫码、真实硬件控制或系统快捷指令 App 中的人工验收。

完整检查、Universal App 打包和签名验证的最终结果在本次交付中列明。临时日志不会随仓库发布。

## 最终检查结果

- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer bash scripts/check.sh`：通过。核心 246 项、App 50 项，共 296 项测试通过（参数化测试在 Swift Testing 报告中按测试项计数）。密钥扫描和机械规范通过，31 张截图基线比较通过。
- `git diff --check`：通过。
- 新增 `Package.resolved` 固定本轮实际验证的测试依赖版本。
- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer bash scripts/build_app.sh`：通过，生成 `MenuBarMijia.app`。
- `lipo -archs`：`x86_64 arm64`；`codesign --verify --deep --strict`：通过。本机使用 ad-hoc 签名。
- 包内 Info.plist 及中英权限文案无麦克风/语音识别声明；签名无录音 entitlement。
- `extract.actionsdata` 仅包含 `GetRoomClimateIntent`、`RunSceneIntent`、`ToggleDeviceIntent`，共三个快捷动作，无 `AskAssistantIntent`。
- 未启动真实家庭会话，未提交、推送或发布。Windows 实现保持原样。
