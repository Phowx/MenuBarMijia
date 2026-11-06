import Foundation
import Testing
@testable import MijiaCore

struct DemoNetworkPolicyTests {
    @MainActor
    @Test("The personal build never restores the original automatic update opt-in")
    func previousUpdateOptInIsRetired() async throws {
        let suite = "test.personal.updates.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: "automatically_checks_for_updates")
        var driver = UpdateSystemDriver.live
        driver.fetchData = { _ in
            Issue.record("Personal build attempted a background release request")
            throw URLError(.notConnectedToInternet)
        }
        let store = HomeStore(provider: MockHomeProvider(), defaultsSuiteName: suite, updater: AppUpdater(driver: driver))
        #expect(!store.automaticallyChecksForUpdates)
        #expect(defaults.object(forKey: "automatically_checks_for_updates") == nil)
        await store.checkForUpdatesIfNeeded()
        #expect(store.updateState == .idle)
    }

    @MainActor
    @Test("Demo mode blocks manual and automatic updates as well as queued downloads")
    func updatesRemainOffline() async throws {
        let suite = "test.demo.updates.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.set(HomeBackend.demo.rawValue, forKey: "home_backend")
        defer { defaults.removePersistentDomain(forName: suite) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("demo-update-\(UUID().uuidString)")
        let target = root.appendingPathComponent("MenuBarMijia.app")
        try FileManager.default.createDirectory(at: target.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let plist = ["CFBundleIdentifier": AppUpdater.expectedBundleIdentifier, "CFBundleShortVersionString": "1.0.0"]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: target.appendingPathComponent("Contents/Info.plist"))
        var driver = UpdateSystemDriver.live
        driver.fetchData = { _ in
            Issue.record("Demo mode attempted a release metadata, checksum or signature request")
            throw URLError(.notConnectedToInternet)
        }
        driver.downloadFile = { _, _, _ in
            Issue.record("Demo mode attempted to download an update")
            throw URLError(.notConnectedToInternet)
        }
        let store = HomeStore(
            provider: MockHomeProvider(), defaultsSuiteName: suite,
            updater: AppUpdater(currentVersion: "1.0.0", targetBundleURL: target, stagingBaseDirectory: root, driver: driver)
        )
        store.automaticallyChecksForUpdates = true
        await store.checkForUpdatesIfNeeded()
        await store.checkForUpdates()
        #expect(store.updateState == .idle)

        let release = AppRelease(
            version: "2.0.0",
            pageURL: try #require(URL(string: "https://example.invalid/release")),
            notes: "Isolated update fixture",
            packageAsset: .init(
                name: "MenuBarMijia-2.0.0.dmg",
                downloadURL: try #require(URL(string: "https://example.invalid/app.dmg")),
                sizeBytes: 1, kind: .dmg,
                integrity: .checksumAssetURL(try #require(URL(string: "https://example.invalid/app.dmg.sha256")))
            )
        )
        store.updateState = .available(release)
        await store.startUpdateInstallation()
        #expect(store.updateState == .available(release))
    }
}
