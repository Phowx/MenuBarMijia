# MenuBarMijia · Windows 自用版

适用于 Windows 11 x64。从任务栏通知区域点击图标，或按默认快捷键 `Alt+M` 呼出面板。首次启动可选“先看演示预览”，再到设置里切换米家云或 Home Assistant。

- 点顶部搜索图标或按 `Ctrl+F` 展开搜索，按 `Esc` 收起。支持设备名、别名、房间名、拼音和拼音首字母。
- 设备卡片、场景和快捷动作可以直接操作设备。支持的操作完成后可在面板里撤销。
- 拖动左上角可以调整面板宽高。设置里可以恢复默认尺寸。
- 右键设备卡片可选择“隐藏此设备”。在设置的“已隐藏的设备”里可以恢复显示，也可开启“隐藏离线设备”。
- 米家扫码与 Home Assistant 连接继续使用 Windows 凭据管理器。已有 Windows 版安装可沿用原来的账号与布局。

## 本地构建

需要 Node.js、Rust MSVC 工具链、Visual Studio C++ Build Tools、Windows SDK 和 WebView2。

```powershell
npm ci
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --bundles nsis -- --locked
```

以上命令在本目录运行。安装包位于 `src-tauri/target/release/bundle/nsis/`。自用版通过重新构建的安装包更新。
