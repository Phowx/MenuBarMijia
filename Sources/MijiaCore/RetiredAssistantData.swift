import Foundation

/// Read-only summaries of old language-created timers. No executable plan is decoded.
public struct RetiredTimer: Decodable, Identifiable, Equatable, Sendable {
    public let id: UUID
    public let reply: String
    public let fireDate: Date
}

/// Upgrade cleanup is deliberately limited to retired assistant keys; device credentials and
/// preferences share the same stores and must never be cleared as a group.
enum RetiredAssistantData {
    static let timerStorageKey = "assistant_scheduled_commands_v1"
    static let credentialAccounts = [
        "assistant_api_key", "assistant_api_key_openrouter_jev", "assistant_api_key_native_jev",
        "assistant_api_key_deepseek", "assistant_api_key_siliconflow", "assistant_api_key_dashscope",
        "assistant_api_key_zhipu_glm", "assistant_api_key_moonshot_kimi", "assistant_api_key_openai",
        "assistant_api_key_gemini", "assistant_api_key_groq", "assistant_api_key_ollama", "assistant_api_key_custom"
    ]

    static func timers(from data: Data?) -> [RetiredTimer] {
        guard let data, let records = try? JSONDecoder().decode([RetiredTimer].self, from: data) else { return [] }
        return records.sorted { $0.fireDate < $1.fireDate }
    }

    static func cleanPreferences(in defaults: UserDefaults) {
        // Only retired feature namespaces, with the timer archive explicitly excluded.
        for key in defaults.dictionaryRepresentation().keys where
            (key.hasPrefix("assistant_") && key != timerStorageKey)
                || key.hasPrefix("keychain_fallback_assistant_api_key") {
            defaults.removeObject(forKey: key)
        }
    }

    static func cleanCredentials(vault: CredentialVault = .shared) {
        for account in credentialAccounts {
            // CredentialVault refuses writes when the shared vault cannot be read. Retrying next
            // launch is safe, and never replaces an unreadable vault with a partial one.
            _ = vault.set(nil, for: account)
        }
    }
}
