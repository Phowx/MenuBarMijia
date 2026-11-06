import Foundation

extension KeychainHelper {
    /// `UserDefaults` key of the plain-text copy that ≤1.0.6 wrote (#16). Nothing writes it any more for
    /// `.standard`; a custom suite uses it as a test-only store so unit tests never touch the real Keychain.
    public static func secretFallbackKey(for account: String) -> String {
        "keychain_fallback_\(account)"
    }

    public static func loadSecret(
        account: String, defaults: UserDefaults = .standard, vault: CredentialVault = .shared
    ) -> String {
        guard defaults === UserDefaults.standard else {
            return defaults.string(forKey: secretFallbackKey(for: account))?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        return readKeychainSecret(account: account, vault: vault) ?? ""
    }

    /// Saving an empty value deletes the item.
    @discardableResult
    public static func saveSecret(
        _ value: String, account: String, defaults: UserDefaults = .standard, vault: CredentialVault = .shared
    ) -> Bool {
        guard defaults === UserDefaults.standard else {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                defaults.removeObject(forKey: secretFallbackKey(for: account))
            } else {
                defaults.set(trimmed, forKey: secretFallbackKey(for: account))
            }
            return true
        }
        // Credentials live only in the Keychain (#16); drop any plain-text copy left behind by ≤1.0.6 once the
        // Keychain accepted the new value, so a failed write never loses the old secret.
        guard writeKeychainSecret(value, account: account, vault: vault) else { return false }
        defaults.removeObject(forKey: secretFallbackKey(for: account))
        return true
    }
}
