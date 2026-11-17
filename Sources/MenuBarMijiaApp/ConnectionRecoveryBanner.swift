import SwiftUI
import MijiaCore

/// Long causes and recovery controls remain inside the scrollable area, including at minimum width.
struct ConnectionRecoveryBanner: View {
    let issue: ConnectionIssue
    var showsCachedState = false
    var lastUpdate: Date?
    let retry: () -> Void
    var openConnection: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(
                issue.recovery == .retryCredentials
                    ? L10n.tr("登录凭据需要处理", "Credentials need attention")
                    : L10n.tr("连接异常", "Connection issue"),
                systemImage: "exclamationmark.triangle.fill"
            )
            .font(.system(size: DesignTokens.TypeSize.caption, weight: .semibold))
            .foregroundStyle(.orange)

            Text(issue.message)
                .font(.system(size: DesignTokens.TypeSize.caption))
                .fixedSize(horizontal: false, vertical: true)

            if showsCachedState {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L10n.tr("当前显示上次同步的设备状态", "Showing last known device states"))
                    if let lastUpdate {
                        Text(L10n.tr("状态更新于：", "Updated: ") + lastUpdate.formatted(date: .omitted, time: .standard))
                    }
                }
                .font(.system(size: DesignTokens.TypeSize.caption))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                if issue.recovery != .signIn {
                    Button(issue.recovery == .retryCredentials
                           ? L10n.tr("重试凭据", "Retry Credentials")
                           : L10n.tr("重试同步", "Retry Sync"), action: retry)
                        .buttonStyle(PillActionButtonStyle(isSelected: true, tintColor: .accentColor))
                }
                if let openConnection {
                    Button(L10n.tr("连接设置", "Connection Settings"), action: openConnection)
                        .buttonStyle(PillActionButtonStyle())
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .adaptiveGlass(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connection-recovery")
    }
}
