import SwiftUI
import AppKit
import MijiaCore

public struct OnboardingGuideView: View {
    @Environment(\.colorScheme) private var colorScheme
    public let store: HomeStore

    @State private var haURLDraft: String = ""
    @State private var haTokenDraft: String = ""

    public init(store: HomeStore) {
        self.store = store
    }

    public var body: some View {
        let _ = store.effectiveLanguage
        VStack(alignment: .leading, spacing: 0) {
            headerBar
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .padding(.bottom, 10)

            Divider()
                .overlay(Color.primary.opacity(0.07))

            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 10) {
                    step1ConnectionCard
                    keyboardGuideCard
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 11)
            }
            .frame(maxHeight: .infinity)

            Divider()
                .overlay(Color.primary.opacity(0.07))

            bottomActionRow
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
        }
        .onAppear {
            haURLDraft = store.serverURLString
            haTokenDraft = KeychainHelper.loadToken()
            if store.miSessionMaskedUserId == nil,
               haTokenDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               store.homeBackend == .homeAssistant {
                // Never pull a user who chose the offline demo back into a cloud login (#47).
                store.switchBackend(.xiaomiCloud)
            }
            Task {
                let found = await store.discoverHomeAssistantOnLAN(autoApplyIfDefault: true)
                if let first = found.first {
                    let normDraft = HAWebSocketProvider.normalizeBaseURL(haURLDraft)
                    if haURLDraft.isEmpty || normDraft == KeychainHelper.defaultNASURL {
                        haURLDraft = first.baseURL
                    }
                }
            }
        }
    }

    // MARK: - Header

    private var headerBar: some View {
        HStack(alignment: .center, spacing: 9) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [Color.orange, Color(red: 0.92, green: 0.38, blue: 0.08)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 28, height: 28)

                Image(systemName: "house.fill")
                    .font(.system(size: 13.5, weight: .bold))
                    .foregroundStyle(.white)
            }

            VStack(alignment: .leading, spacing: 1.5) {
                Text(L10n.tr("欢迎使用 MenuBarMijia", "Welcome to MenuBarMijia"))
                    .font(.system(size: 14, weight: .bold))
                    .tracking(-0.2)

                Text(L10n.tr("30 秒完成配置 · 菜单栏一秒掌控米家", "30-second setup · Control Xiaomi Home from your menu bar"))
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button(store.effectiveLanguage == .en ? "中文" : "EN") {
                withAnimation(AppleMotion.snappySpring) {
                    store.appLanguagePreference = (store.effectiveLanguage == .en) ? .zhHans : .en
                }
            }
            .buttonStyle(PillActionButtonStyle())
            .help(L10n.tr("切换为英文界面 / Switch to English", "Switch to Chinese / 切换为中文界面"))

            Button(L10n.tr("跳过", "Skip")) {
                withAnimation(AppleMotion.snappySpring) {
                    store.completeOnboarding()
                }
            }
            .buttonStyle(PillActionButtonStyle())
        }
    }

    // MARK: - Step 1: Connect Devices

    private var step1ConnectionCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                stepBadge("1", isDone: isBackendConnected)
                Text(L10n.tr("连接你的米家设备", "Connect Your Devices"))
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                if isBackendConnected {
                    Label(L10n.tr("已连接", "Connected"), systemImage: "checkmark.circle.fill")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(.green)
                } else if let firstHA = store.discoveredHAInstances.first {
                    Button {
                        withAnimation(AppleMotion.snappySpring) {
                            haURLDraft = firstHA.baseURL
                            store.applyDiscoveredHAInstance(firstHA, reconnectProvider: false)
                            store.switchBackend(.homeAssistant)
                        }
                    } label: {
                        Label(
                            L10n.tr("已发现局域网 HA · \(firstHA.hostAndPort)", "Found LAN HA · \(firstHA.hostAndPort)"),
                            systemImage: "dot.radiowaves.left.and.right"
                        )
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.green)
                    }
                    .buttonStyle(.plain)
                } else {
                    Text(L10n.tr("推荐手机扫码", "QR Login Recommended"))
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.orange)
                }
            }

            Picker(
                "",
                selection: Binding(
                    get: { store.homeBackend },
                    set: { newBackend in
                        withAnimation(AppleMotion.snappySpring) {
                            store.switchBackend(newBackend)
                        }
                    }
                )
            ) {
                ForEach(HomeBackend.allCases) { backend in
                    Text(backend.title).tag(backend)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)

            // #47: let people try the panel before signing any account in.
            if store.homeBackend == .demo {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "play.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                        .padding(.top, 1)
                    Text(L10n.tr(
                        "演示模式已开启：内置虚拟家庭，完全离线，不发起任何网络请求。选择上方「米家云端直连」或「Home Assistant」即可切回真实账号。",
                        "Demo mode is on: a built-in virtual home, fully offline, no network requests. Pick Xiaomi Cloud or Home Assistant above to switch back to a real account."
                    ))
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                .padding(8)
                .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            } else {
                HStack(spacing: 6) {
                    Button {
                        withAnimation(AppleMotion.snappySpring) {
                            store.switchBackend(.demo)
                            // No `completeOnboarding()`: once demo devices arrive the guide hides by
                            // itself, and switching to an account without credentials shows it again.
                            store.showToast(L10n.tr("已进入演示模式，可随时在设置里切回真实账号", "Demo mode on; switch back anytime in Settings"))
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "play.rectangle")
                            Text(L10n.tr("先看看演示（无需账号）", "Try the Demo (No Account)"))
                        }
                        .font(.system(size: 10.5, weight: .semibold))
                    }
                    .buttonStyle(PillActionButtonStyle(isSelected: true, tintColor: .orange))

                    Text(L10n.tr("用虚拟设备体验面板与皮肤", "Explore the dashboard with virtual devices"))
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
            }

            if store.homeBackend == .xiaomiCloud {
                MiAccountSection(store: store)
            } else if store.homeBackend == .homeAssistant {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        TextField("https://your-home.ui.nabu.casa", text: $haURLDraft)
                            .textFieldStyle(.roundedBorder)
                            .controlSize(.small)
                            .font(.system(size: 11, design: .monospaced))

                        Button(store.isDiscoveringHA ? L10n.tr("扫描中…", "Scanning…") : L10n.tr("自动扫描", "Auto Scan")) {
                            Task {
                                let found = await store.discoverHomeAssistantOnLAN(autoApplyIfDefault: false)
                                if let first = found.first {
                                    haURLDraft = first.baseURL
                                    store.showToast(L10n.tr("已发现：\(first.displaySummary)", "Found: \(first.displaySummary)"))
                                } else {
                                    store.showToast(L10n.tr("未在局域网扫描到 Home Assistant", "No Home Assistant found on LAN"), isError: true)
                                }
                            }
                        }
                        .buttonStyle(PillActionButtonStyle())
                        .disabled(store.isDiscoveringHA)
                    }

                    if let address = URL(string: HAWebSocketProvider.normalizeBaseURL(haURLDraft)),
                       address.scheme == "http",
                       let host = address.host,
                       !["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased()) {
                        Label(L10n.tr("令牌将以明文在网络上传输，建议使用 HTTPS 或 Nabu Casa 地址。", "Your token will travel unencrypted. Use HTTPS or a Nabu Casa address."), systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 10.5))
                            .foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let firstHA = store.discoveredHAInstances.first {
                        HStack(spacing: 5) {
                            Image(systemName: "checkmark.seal.fill")
                                .font(.system(size: 10))
                                .foregroundStyle(.green)
                            Text(L10n.tr("已自动识别局域网 HA：\(firstHA.displaySummary)", "Detected LAN HA: \(firstHA.displaySummary)"))
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Spacer()
                            if let secURL = URL(string: "\(HAWebSocketProvider.normalizeBaseURL(haURLDraft))/profile/security") {
                                Button(L10n.tr("打开网页取令牌", "Open Security Page")) {
                                    NSWorkspace.shared.open(secURL)
                                }
                                .buttonStyle(.plain)
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(Color.accentColor)
                            }
                        }
                    }

                    HStack(spacing: 6) {
                        SecureField(L10n.tr("粘贴 HA 长期访问令牌", "Paste HA Long-Lived Access Token"), text: $haTokenDraft)
                            .textFieldStyle(.roundedBorder)
                            .controlSize(.small)
                            .font(.system(size: 11, design: .monospaced))

                        Button(L10n.tr("连接", "Connect")) {
                            store.updateConnection(serverURL: haURLDraft, token: haTokenDraft)
                        }
                        .buttonStyle(PillActionButtonStyle(isSelected: true, tintColor: .accentColor))
                    }
                }
            }
        }
        .padding(11)
        .glassTile(isActive: isBackendConnected, cornerRadius: 12)
    }

    private var keyboardGuideCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.tr("键盘操作", "Keyboard Controls"))
                .font(.headline)
            Text(L10n.tr(
                "⌥M 呼出或收起面板；直接输入名称、房间或拼音搜索设备。↑↓ 选择，回车开关，→ 展开详情，Esc 退出。",
                "Toggle the panel with ⌥M. Type a name, room or pinyin to search. ↑↓ selects, Return toggles, → opens details, and Esc exits."
            ))
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(11)
        .glassTile(isActive: false, cornerRadius: 12)
    }

    // MARK: - Footer

    private var bottomActionRow: some View {
        HStack {
            Text(L10n.tr("随时可在「偏好设置 → 新手引导」重新打开", "Reopen anytime in Settings → Guide"))
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)

            Spacer()

            Button {
                withAnimation(AppleMotion.snappySpring) {
                    store.completeOnboarding()
                }
            } label: {
                HStack(spacing: 4) {
                    Text(L10n.tr("开始使用", "Get Started"))
                    Image(systemName: "arrow.right")
                }
                .font(.system(size: 11.5, weight: .semibold))
            }
            .buttonStyle(PillActionButtonStyle(isSelected: true, tintColor: .accentColor))
        }
    }

    // MARK: - Subviews

    private var isBackendConnected: Bool {
        if store.homeBackend == .demo { return true }
        if case .connected = store.connectionStatus { return true }
        if store.homeBackend == .xiaomiCloud && store.miSessionMaskedUserId != nil { return true }
        return false
    }

    private func stepBadge(_ number: String, isDone: Bool) -> some View {
        ZStack {
            Circle()
                .fill(isDone ? Color.green.opacity(0.2) : Color.accentColor.opacity(0.18))
                .frame(width: 18, height: 18)
            if isDone {
                Image(systemName: "checkmark")
                    .font(.system(size: 9.5, weight: .bold))
                    .foregroundStyle(.green)
            } else {
                Text(number)
                    .font(.system(size: 10.5, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.accentColor)
            }
        }
    }

    private func shortcutTipRow(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 16, alignment: .center)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                Text(detail)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
