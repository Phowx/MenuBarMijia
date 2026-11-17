import Foundation
import Testing
@testable import MijiaCore

struct CloudResponseValidationTests {
    @Test("HTTP errors cannot be disguised by a success envelope", arguments: [401, 403, 429, 500, 503])
    func httpErrors(_ status: Int) {
        let expected: MiCloudError = status == 401 ? .sessionExpired : .http(status)
        #expect(throws: expected) {
            try MiCloudClient.decodeResponse(Data(#"{"code":0,"result":{"list":[]}}"#.utf8), statusCode: status, signedNonce: "unused")
        }
    }

    @Test("Status code must be an actual integer", arguments: [JSONValue.null, .string("0"), .number(0.5), .bool(false), .number(1e100)])
    func invalidCode(_ code: JSONValue) {
        #expect(throws: MiCloudError.self) { try MiCloudClient.unwrapResult(.object(["code": code])) }
    }

    @Test("Missing status and malformed lists fail; an explicitly empty home remains valid")
    func malformedLists() throws {
        #expect(throws: MiCloudError.self) { try MiCloudClient.unwrapResult(.object([:])) }
        for malformed: JSONValue in [.null, .object([:]), .object(["list": .null]), .object(["list": .object([:])]), .object(["list": .array([.null, .object([:])])])] {
            #expect(throws: MiCloudError.self) { try MiCloudClient.parseDeviceList(malformed) }
        }
        #expect(try MiCloudClient.parseDeviceList(.object(["list": .array([])])).isEmpty)
        #expect(throws: MiCloudError.self) { try MiCloudClient.parsePropValues(.object([:])) }
        #expect(try MiCloudClient.parsePropValues(.array([])).isEmpty)
        #expect(throws: MiCloudError.self) { try MiCloudClient.parseRooms(.object([:])) }
        #expect(throws: MiCloudError.self) { try MiCloudClient.parseRooms(.object(["homelist": .array([.null])])) }
        #expect(try MiCloudClient.parseRooms(.object(["homelist": .array([])])).isEmpty)
    }

    @Test("Explicit expiry wins over code zero, while a signature error asks for sync retry")
    func failureClassification() throws {
        for message in ["SERVICETOKEN_EXPIRED", "token expired", "auth err"] {
            #expect(throws: MiCloudError.sessionExpired) {
                try MiCloudClient.unwrapResult(.object(["code": .number(0), "message": .string(message)]))
            }
        }
        do {
            _ = try MiCloudClient.unwrapResult(.object(["code": .number(0), "message": .string("invalid signature")]))
            Issue.record("Signature failure was accepted")
        } catch {
            #expect(ConnectionIssue(error: error).recovery == .retrySync)
        }
        #expect(ConnectionIssue(error: MiCloudError.sessionExpired).recovery == .signIn)
        #expect(ConnectionIssue(error: CredentialStoreError.unavailable).recovery == .retryCredentials)
    }
}

/// Fails individual discovery/polling stages after the first good snapshot.
actor RecoveryAPI: MiCloudAPI {
    enum Stage: Sendable { case devices, rooms, properties }
    private var failure: (Stage, MiCloudError)?
    private(set) var discoveryCalls = 0
    func fail(_ stage: Stage, with error: MiCloudError) { failure = (stage, error) }
    func recover() { failure = nil }
    func deviceList() throws -> [MiDeviceRecord] {
        discoveryCalls += 1
        if let (stage, error) = failure, stage == .devices { throw error }
        return [MiotFixtures.lightRecord]
    }
    func homeRooms() throws -> [MiRoom] {
        if let (stage, error) = failure, stage == .rooms { throw error }
        return [MiRoom(id: "r", name: "书房", dids: [MiotFixtures.lightRecord.did])]
    }
    func getProps(_ keys: [MiotPropKey]) throws -> [MiotPropKey: JSONValue] {
        if let (stage, error) = failure, stage == .properties { throw error }
        return MiotFixtures.lightValues
    }
    func setProps(_ writes: [MiotPropWrite]) {}
    func action(_ call: MiotActionCall) {}
}

@MainActor
struct CloudRecoveryTests {
    private let session = MiSession(userId: "42", cUserId: "c", ssecurity: "c2VjcmV0", serviceToken: "test-session")

    private func wait(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<200 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }

    @Test("Discovery, room and property errors preserve last good devices and recover without QR", arguments: [RecoveryAPI.Stage.devices, .rooms, .properties])
    func cachedStateSurvives(_ stage: RecoveryAPI.Stage) async throws {
        let api = RecoveryAPI()
        let provider = MiCloudProvider(sessionLoader: { session }, apiFactory: { _ in api }, specSource: StubSpecSource(), pollInterval: .seconds(60))
        let suite = "test.cloud-recovery.\(UUID().uuidString)"
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let store = HomeStore(provider: provider, defaultsSuiteName: suite)
        store.homeBackend = .xiaomiCloud
        defer { store.eventTask?.cancel(); Task { await provider.shutdown() } }
        #expect(await wait { store.connectionStatus.isConnected && !store.devices.isEmpty })
        let before = store.devices
        let timestamp = store.lastSnapshotAt
        await api.fail(stage, with: .badResponse("malformed test response"))
        await provider.refreshNow()
        #expect(await wait { store.connectionIssue != nil })
        #expect(store.devices == before)
        #expect(store.lastSnapshotAt == timestamp)
        #expect(store.connectionIssue?.recovery == .retrySync)
        await api.recover()
        await provider.refreshNow()
        #expect(await wait { store.connectionStatus.isConnected && store.connectionIssue == nil })
    }

    @Test("Explicit expiry stops automatic polling and presents login recovery")
    func expiryStopsPolling() async throws {
        let api = RecoveryAPI()
        await api.fail(.devices, with: .sessionExpired)
        let provider = MiCloudProvider(sessionLoader: { session }, apiFactory: { _ in api }, specSource: StubSpecSource(), pollInterval: .milliseconds(10))
        let suite = "test.cloud-expiry.\(UUID().uuidString)"
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let store = HomeStore(provider: provider, defaultsSuiteName: suite)
        store.homeBackend = .xiaomiCloud
        defer { store.eventTask?.cancel(); Task { await provider.shutdown() } }
        #expect(await wait { store.connectionIssue?.recovery == .signIn })
        try await Task.sleep(for: .milliseconds(150))
        #expect(await api.discoveryCalls == 1)
    }

    @Test("Unread credentials are preserved; only an explicit retry rereads Keychain")
    func unavailableCredentials() async throws {
        let data = try JSONEncoder().encode(session)
        let storage = MemoryVaultStorage(blob: CredentialVault.encode(["mi_session": data]))
        storage.readResult = .unavailable
        let vault = CredentialVault(storage: storage.storage)
        let suite = "test.cloud-keychain.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.set(HomeBackend.xiaomiCloud.rawValue, forKey: "home_backend")
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let api = RecoveryAPI()
        let store = HomeStore(defaultsSuiteName: suite, credentialVault: vault, cloudAPIFactory: { _ in api })
        defer { store.eventTask?.cancel(); store.shutdownCurrentProvider() }
        #expect(store.credentialIssue?.recovery == .retryCredentials)
        #expect(store.shouldShowOnboarding == false)
        #expect(await wait { store.connectionIssue != nil })
        #expect(storage.reads == 1)
        #expect(storage.writes == 0)
        storage.readResult = nil
        store.retryCredentials()
        #expect(await wait { store.connectionStatus.isConnected })
        #expect(store.credentialIssue == nil)
        #expect(store.miSessionMaskedUserId == session.maskedUserId)
        #expect(storage.reads == 2)
        #expect(storage.storedItems?["mi_session"] == data)
    }

    @Test("A failed login save keeps the new session live and retries without deleting other accounts")
    func saveFailureKeepsSession() async throws {
        let old = MiSession(userId: "old", cUserId: "c", ssecurity: "c2VjcmV0", serviceToken: "old-session")
        let storage = MemoryVaultStorage(blob: CredentialVault.encode(["mi_session": try JSONEncoder().encode(old), "ha_access_token": Data("keep-ha".utf8)]))
        storage.writeSucceeds = false
        let vault = CredentialVault(storage: storage.storage)
        let suite = "test.cloud-save.\(UUID().uuidString)"
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let api = RecoveryAPI()
        let store = HomeStore(provider: MockHomeProvider(), defaultsSuiteName: suite, credentialVault: vault, cloudAPIFactory: { received in
            #expect(received == session, "the provider must use the newly scanned session, never the old stored one")
            return api
        })
        defer { store.eventTask?.cancel(); store.shutdownCurrentProvider() }
        store.completeMiLogin(session)
        #expect(store.toastNotice?.isError == true)
        #expect(store.pendingMiSession == session)
        #expect(await wait { store.connectionStatus.isConnected })
        #expect(store.credentialIssue != nil, "network success must not hide a failed save")
        #expect(try JSONDecoder().decode(MiSession.self, from: #require(storage.storedItems?["mi_session"])) == old)
        storage.writeSucceeds = true
        store.retryCredentials()
        #expect(store.pendingMiSession == nil)
        #expect(store.credentialIssue == nil)
        #expect(try MiSessionStore.loadChecked(defaults: store.userDefaults, vault: vault) == session)
        #expect(storage.storedItems?["ha_access_token"] == Data("keep-ha".utf8))
    }

    @Test("An unread HA token cannot be erased by saving an empty settings field")
    func emptyPreferenceSaveIsBlocked() throws {
        let storage = MemoryVaultStorage(blob: CredentialVault.encode(["ha_access_token": Data("keep-ha".utf8)]))
        storage.readResult = .unavailable
        let vault = CredentialVault(storage: storage.storage)
        let suite = "test.ha-read.\(UUID().uuidString)"
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let store = HomeStore(provider: MockHomeProvider(), defaultsSuiteName: suite, credentialVault: vault)
        defer { store.eventTask?.cancel() }
        storage.readResult = nil
        store.updateConnection(serverURL: "http://127.0.0.1:1", token: "")
        #expect(storage.writes == 0)
        #expect(store.credentialsNeedReading)
        #expect(store.toastNotice?.isError == true)
    }
    @Test("Invalid saved session data remains intact and is distinguished from a missing session")
    func invalidCredentialData() throws {
        let raw = Data("not-valid-session-json".utf8)
        let storage = MemoryVaultStorage(blob: CredentialVault.encode(["mi_session": raw, "ha_access_token": Data([0xff])]))
        let vault = CredentialVault(storage: storage.storage)
        #expect(throws: CredentialStoreError.invalidData) { try MiSessionStore.loadChecked(vault: vault) }
        #expect(throws: CredentialStoreError.invalidData) { try KeychainHelper.loadTokenChecked(vault: vault) }
        #expect(storage.writes == 0)
        #expect(storage.storedItems?["mi_session"] == raw)
        let emptyVault = CredentialVault(storage: MemoryVaultStorage().storage)
        #expect(try MiSessionStore.loadChecked(vault: emptyVault) == nil)
    }

    @Test("A failed HA credential save is reported and Settings keeps the new in-memory token")
    func failedHASave() async throws {
        let storage = MemoryVaultStorage(blob: CredentialVault.encode(["ha_access_token": Data("old-ha".utf8)]))
        storage.writeSucceeds = false
        let vault = CredentialVault(storage: storage.storage)
        let suite = "test.ha-save.\(UUID().uuidString)"
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let store = HomeStore(provider: MockHomeProvider(), defaultsSuiteName: suite, credentialVault: vault)
        store.updateConnection(serverURL: "http://127.0.0.1:1", token: "new-ha")
        #expect(store.toastNotice?.isError == true)
        #expect(store.credentialIssue != nil)
        #expect(store.haTokenForCurrentSession == "new-ha")
        #expect(storage.storedItems?["ha_access_token"] == Data("old-ha".utf8))
        // Let the connection task attach before shutting it down; no real HA server is contacted.
        try await Task.sleep(for: .milliseconds(20))
        store.eventTask?.cancel()
        if let provider = store.provider as? HAWebSocketProvider { await provider.shutdown() }
    }

}
