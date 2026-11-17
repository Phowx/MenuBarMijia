import Foundation

extension HomeStore {
    /// Settings and address changes must use an unsaved token from this session before the old vault value.
    public var haTokenForCurrentSession: String {
        pendingHAToken ?? ((try? KeychainHelper.loadTokenChecked(defaults: userDefaults, vault: credentialVault)) ?? "")
    }

    static var unsavedCredentialIssue: ConnectionIssue {
        ConnectionIssue(
            message: L10n.tr("登录凭据尚未保存到钥匙串。当前会话仍可使用，退出前请重试保存。", "Credentials have not been saved to Keychain. This session still works; retry saving before quitting."),
            recovery: .retryCredentials
        )
    }

    func loadHACredentials() -> String {
        if let pendingHAToken {
            credentialsNeedReading = false
            credentialIssue = Self.unsavedCredentialIssue
            return pendingHAToken
        }
        do {
            let token = try KeychainHelper.loadTokenChecked(defaults: userDefaults, vault: credentialVault)
            credentialsNeedReading = false
            credentialIssue = nil
            return token
        } catch {
            credentialsNeedReading = true
            credentialIssue = ConnectionIssue(error: error)
            return ""
        }
    }

    func makeMiCloudProvider() -> MiCloudProvider {
        do {
            activeMiSession = try pendingMiSession ?? MiSessionStore.loadChecked(defaults: userDefaults, vault: credentialVault)
            credentialsNeedReading = false
            credentialIssue = pendingMiSession == nil ? nil : Self.unsavedCredentialIssue
        } catch {
            credentialsNeedReading = true
            activeMiSession = nil
            credentialIssue = ConnectionIssue(error: error)
        }
        miSessionMaskedUserId = activeMiSession?.maskedUserId
        miSessionScopeIdentifier = activeMiSession?.historyScopeIdentifier
        let session = activeMiSession
        let vault = credentialVault
        nonisolated(unsafe) let defaults = userDefaults
        return MiCloudProvider(sessionLoader: {
            if let session { return session }
            return try MiSessionStore.loadChecked(defaults: defaults, vault: vault)
        }, apiFactory: cloudAPIFactory)
    }

    /// A button-driven retry, so denied Keychain access never causes a background prompt loop.
    public func retryCredentials() {
        guard homeBackend != .demo else { return }
        if userDefaults === UserDefaults.standard || credentialVault != nil {
            (credentialVault ?? .shared).retryReading()
        }
        switch homeBackend {
        case .xiaomiCloud:
            if let session = pendingMiSession {
                guard MiSessionStore.save(session, defaults: userDefaults, vault: credentialVault) else {
                    credentialIssue = Self.unsavedCredentialIssue
                    return
                }
                pendingMiSession = nil
            }
            eventTask?.cancel()
            shutdownCurrentProvider()
            provider = makeMiCloudProvider()
        case .homeAssistant:
            if let token = pendingHAToken {
                guard KeychainHelper.saveToken(token, defaults: userDefaults, vault: credentialVault) else {
                    credentialIssue = Self.unsavedCredentialIssue
                    return
                }
                pendingHAToken = nil
            }
            let token = loadHACredentials()
            eventTask?.cancel()
            shutdownCurrentProvider()
            provider = makeHAProvider(baseURLString: serverURLString, token: token)
        case .demo:
            return
        }
        startListening()
    }

    public var visibleConnectionIssue: ConnectionIssue? { credentialIssue ?? connectionIssue }
}
