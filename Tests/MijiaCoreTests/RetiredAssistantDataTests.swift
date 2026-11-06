import Foundation
import Testing
@testable import MijiaCore

struct RetiredAssistantDataTests {
    @Test("Old future and expired timers survive relaunch but never dispatch commands")
    @MainActor
    func timersAreInertAndPreserved() async throws {
        let suite = "test.retired.timers.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date()
        let records: [[String: Any]] = [-600.0, 0.01, 600].map { offset in
            ["id": UUID().uuidString, "reply": "旧定时关灯",
             "fireDate": now.addingTimeInterval(offset).timeIntervalSinceReferenceDate,
             "plan": ["source": "local", "intents": [["targetId": "light", "operation": ["power": ["_0": false]]]]]]
        }
        let data = try JSONSerialization.data(withJSONObject: records)
        defaults.set(data, forKey: RetiredAssistantData.timerStorageKey)
        let mock = MockHomeProvider(snapshot: .init(devices: [DeviceFixtures.studyCeiling]))
        let first = HomeStore(provider: mock, defaultsSuiteName: suite)
        try await first.waitForInitialSnapshot()
        try await Task.sleep(for: .milliseconds(80))
        #expect(first.retiredTimers.count == 3)
        #expect(await mock.executedCommands.isEmpty)
        #expect(defaults.data(forKey: RetiredAssistantData.timerStorageKey) == data)
        let nextMock = MockHomeProvider()
        let second = HomeStore(provider: nextMock, defaultsSuiteName: suite)
        #expect(second.retiredTimerData == data)
        #expect(second.retiredTimers == first.retiredTimers)
        #expect(await nextMock.executedCommands.isEmpty)
        second.clearRetiredTimers()
        #expect(second.retiredTimerData == nil)
        #expect(defaults.data(forKey: RetiredAssistantData.timerStorageKey) == nil)
    }

    @Test("Unreadable legacy timer data remains available for explicit clearing")
    @MainActor
    func malformedArchiveIsNotLost() throws {
        let suite = "test.retired.malformed.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let bytes = Data("invalid archive".utf8)
        defaults.set(bytes, forKey: RetiredAssistantData.timerStorageKey)
        let store = HomeStore(provider: MockHomeProvider(), defaultsSuiteName: suite)
        #expect(store.retiredTimerData == bytes)
        #expect(store.retiredTimers.isEmpty)
        #expect(defaults.data(forKey: RetiredAssistantData.timerStorageKey) == bytes)
    }

    @Test("Cleanup deletes assistant settings and keys while preserving device accounts and preferences")
    func cleanupIsScopedAndIdempotent() throws {
        let suite = "test.retired.cleanup.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("old endpoint", forKey: "assistant_base_url")
        defaults.set("old habits", forKey: "assistant_user_habit_memory_v1")
        defaults.set("old key", forKey: "keychain_fallback_assistant_api_key")
        defaults.set("device token", forKey: "keychain_fallback_ha_access_token")
        defaults.set(["a"], forKey: "favorite_device_ids")
        defaults.set(Data("archive".utf8), forKey: RetiredAssistantData.timerStorageKey)
        let storage = MemoryVaultStorage()
        let vault = CredentialVault(storage: storage.storage)
        for account in ["ha_access_token", "mi_session", "lg_webos_client_key"] + RetiredAssistantData.credentialAccounts {
            #expect(vault.set(Data(account.utf8), for: account))
        }
        for _ in 0..<2 {
            RetiredAssistantData.cleanPreferences(in: defaults)
            RetiredAssistantData.cleanCredentials(vault: vault)
        }
        #expect(defaults.string(forKey: "assistant_base_url") == nil)
        #expect(defaults.string(forKey: "assistant_user_habit_memory_v1") == nil)
        #expect(defaults.string(forKey: "keychain_fallback_assistant_api_key") == nil)
        #expect(defaults.string(forKey: "keychain_fallback_ha_access_token") == "device token")
        #expect(defaults.stringArray(forKey: "favorite_device_ids") == ["a"])
        #expect(defaults.data(forKey: RetiredAssistantData.timerStorageKey) == Data("archive".utf8))
        for account in ["ha_access_token", "mi_session", "lg_webos_client_key"] {
            #expect(vault.lookup(account) == .value(Data(account.utf8)))
        }
        for account in RetiredAssistantData.credentialAccounts { #expect(vault.lookup(account) == .missing) }
    }

    @Test("Cleanup cannot overwrite an unreadable shared credential vault")
    func unavailableVaultIsPreserved() throws {
        let original = try #require(CredentialVault.encode(["mi_session": Data("session".utf8)]))
        let storage = MemoryVaultStorage(blob: original)
        storage.readResult = .unavailable
        let vault = CredentialVault(storage: storage.storage)
        RetiredAssistantData.cleanCredentials(vault: vault)
        #expect(storage.writes == 0)
        #expect(storage.rawBlob == original)
    }
}
