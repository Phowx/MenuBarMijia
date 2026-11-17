import Foundation

public enum CredentialStoreError: LocalizedError, Equatable, Sendable {
    case unavailable
    case invalidData

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            return L10n.tr("暂时无法读取钥匙串中的登录凭据。已保存的信息仍保留，请重试读取，无需重新扫码。", "Saved credentials are unavailable in Keychain. They have been preserved. Retry reading them; you do not need to scan again.")
        case .invalidData:
            return L10n.tr("已保存的登录凭据无法解析，原始记录已保留。请重试读取或在连接设置中处理。", "Saved credentials could not be decoded. The original data has been preserved. Retry reading them or open connection settings.")
        }
    }
}

/// Recovery is carried as data, never inferred from a translated error message.
public struct ConnectionIssue: Equatable, Sendable {
    public enum Recovery: Equatable, Sendable {
        case retrySync
        case signIn
        case retryCredentials
    }

    public var message: String
    public var recovery: Recovery

    public init(message: String, recovery: Recovery) {
        self.message = message
        self.recovery = recovery
    }

    init(error: any Error) {
        message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        if error is CredentialStoreError {
            recovery = .retryCredentials
        } else if let cloudError = error as? MiCloudError,
                  cloudError == .notLoggedIn || cloudError == .sessionExpired {
            recovery = .signIn
        } else {
            recovery = .retrySync
        }
    }
}
