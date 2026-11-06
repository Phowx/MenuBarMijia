import Foundation
import Testing
@testable import MijiaCore

struct DeviceActionTests {
    @Test("Failed All Off and quick actions roll back and leave no false undo entry", arguments: [false, true])
    @MainActor
    func rejectedBatchRollsBack(quickAction: Bool) async throws {
        let suite = "test.actions.batch.reject.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let mock = MockHomeProvider(snapshot: .init(devices: [DeviceFixtures.bedsideLamp]))
        await mock.setShouldFail(true)
        let store = HomeStore(provider: mock, defaultsSuiteName: suite)
        try await store.waitForInitialSnapshot()
        if quickAction { store.executeQuickAction(.lightsOff) } else { store.turnAllOff() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while store.toastNotice?.isError != true, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(store.toastNotice?.isError == true)
        #expect(store.devices.first?.isActiveOn == true)
        #expect(store.undoBanner == nil)
        #expect(store.lastActionAt == nil)
    }

    @Test("Explicit actions still clamp device ranges and can undo without a language parser")
    @MainActor
    func validatesAndRestores() async throws {
        let suite = "test.actions.ranges.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let mock = MockHomeProvider(snapshot: .init(devices: [DeviceFixtures.studyCeiling]))
        let store = HomeStore(provider: mock, defaultsSuiteName: suite)
        try await store.waitForInitialSnapshot()
        await store.runAutomation(intents: [.init(targetId: DeviceFixtures.studyCeiling.id, operation: .brightness(500))], title: "调节灯光")
        #expect(await mock.executedCommands.first == .setLightBrightness(entityId: "light.study_ceiling", percent: 100))
        #expect(store.devices.first?.isActiveOn == true)
        #expect(store.lastActionAt != nil)
        await store.undoLastAction()
        #expect(store.devices.first?.isActiveOn == false)
        #expect(store.lastActionAt == nil)
    }

    @Test("Rejected device actions roll back and create no undo record")
    @MainActor
    func rejectedActionRollsBack() async throws {
        let suite = "test.actions.reject.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let mock = MockHomeProvider(snapshot: .init(devices: [DeviceFixtures.studyCeiling]))
        await mock.setShouldFail(true)
        let store = HomeStore(provider: mock, defaultsSuiteName: suite)
        try await store.waitForInitialSnapshot()
        await store.runAutomation(intents: [.init(targetId: DeviceFixtures.studyCeiling.id, operation: .power(true))], title: "开灯")
        #expect(store.devices.first?.isActiveOn == false)
        #expect(store.undoBanner == nil)
        #expect(store.lastActionAt == nil)
        #expect(store.toastNotice?.isError == true)
    }

    @Test("Failed undo restores the pre-undo UI state and reports failure instead of success")
    @MainActor
    func rejectedUndoReportsFailure() async throws {
        let suite = "test.actions.undo.reject.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let mock = MockHomeProvider(snapshot: .init(devices: [DeviceFixtures.studyCeiling]))
        let store = HomeStore(provider: mock, defaultsSuiteName: suite)
        try await store.waitForInitialSnapshot()
        await store.runAutomation(intents: [.init(targetId: DeviceFixtures.studyCeiling.id, operation: .power(true))], title: "开灯")
        await mock.setShouldFail(true)
        await store.undoTurnAllOff()?.value
        #expect(store.devices.first?.isActiveOn == true)
        #expect(store.toastNotice?.isError == true)
        #expect(store.lastActionAt == nil)
        #expect(store.undoBanner == nil)
        #expect(await mock.executedCommands.count == 1)
    }
}
