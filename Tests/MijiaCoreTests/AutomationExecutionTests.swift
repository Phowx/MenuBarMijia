import Foundation
import Testing
@testable import MijiaCore

/// #59: automation executions go through HomeStore's normal dispatch path, offer undo even for a single device.
struct AutomationExecutionTests {
    static let studyLight = SmartDevice(
        id: "light_study",
        name: "书房台灯",
        roomId: "study",
        roomName: "书房",
        model: "yeelink.light.lamp4",
        isOnline: true,
        kind: .light(LightSpec(entityId: "light.study", isOn: true))
    )
    static let hiddenLight = SmartDevice(
        id: "light_aquarium",
        name: "鱼缸灯",
        roomId: "study",
        roomName: "书房",
        model: "yeelink.light.strip2",
        isOnline: true,
        kind: .light(LightSpec(entityId: "light.aquarium", isOn: true))
    )
    static let offlineLight = SmartDevice(
        id: "light_balcony",
        name: "阳台灯",
        roomId: "balcony",
        roomName: "阳台",
        model: "yeelink.light.lamp4",
        isOnline: false,
        kind: .light(LightSpec(entityId: "light.balcony", isOn: false))
    )
    static let scenes = [
        HomeScene(id: "scene_home", name: "回家模式", entityId: "scene.home")
    ]

    @MainActor
    private func makeStore() async throws -> (HomeStore, MockHomeProvider) {
        let mock = MockHomeProvider(snapshot: SynthesizedHome(
            devices: [Self.studyLight, Self.hiddenLight, Self.offlineLight],
            scenes: Self.scenes
        ))
        let store = HomeStore(provider: mock, defaultsSuiteName: "test.automation.exec.\(UUID().uuidString)")
        for _ in 0..<50 where store.devices.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        store.hideDevice(Self.hiddenLight.id)
        return (store, mock)
    }

    @Test("A device rule runs through the store, keeps its undo banner, without a language parser")
    @MainActor
    func deviceAutomation() async throws {
        let (store, mock) = try await makeStore()
        let plan = await store.runAutomation(
            intents: [DeviceIntent(targetId: Self.studyLight.id, operation: .power(false))],
            title: "锁屏关灯"
        )

        #expect(plan.reply == "锁屏关灯")
        #expect(store.devices.first(where: { $0.id == Self.studyLight.id })?.isActiveOn == false)
        #expect(store.devices.first(where: { $0.id == Self.hiddenLight.id })?.isActiveOn == true)
        #expect(store.undoBanner?.title == "锁屏关灯")
        #expect(store.undoBanner?.restoreCommands == [
            .setLightPower(entityId: "light.study", isOn: true)
        ])
        let commands = await mock.executedCommands
        #expect(commands == [.setLightPower(entityId: "light.study", isOn: false)])
    }

    @Test("A scene rule activates the scene and offers no device undo")
    @MainActor
    func sceneAutomation() async throws {
        let (store, mock) = try await makeStore()
        _ = await store.runAutomation(
            intents: [DeviceIntent(targetId: "scene_home", operation: .activateScene)],
            title: "接入显示器"
        )

        let commands = await mock.executedCommands
        #expect(commands == [.activateScene(entityId: "scene.home")])
        #expect(store.undoBanner == nil)
    }

    @Test("Banner undo consumes the command so a second undo cannot overwrite a later manual change")
    @MainActor
    func bannerUndoIsConsumed() async throws {
        let (store, mock) = try await makeStore()
        await store.runAutomation(
            intents: [DeviceIntent(targetId: Self.studyLight.id, operation: .power(false))],
            title: "锁屏关灯"
        )
        store.undoTurnAllOff()
        #expect(store.lastActionAt == nil)
        for _ in 0..<50 {
            if await mock.executedCommands.count >= 2 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let light = try #require(store.devices.first(where: { $0.id == Self.studyLight.id }))
        let task = try #require(store.togglePrimary(light))
        #expect(await task.value)
        await store.undoLastAction()
        #expect(store.devices.first(where: { $0.id == Self.studyLight.id })?.isActiveOn == false)
        #expect(await mock.executedCommands == [
            .setLightPower(entityId: "light.study", isOn: false),
            .setLightPower(entityId: "light.study", isOn: true),
            .setLightPower(entityId: "light.study", isOn: false)
        ])
    }

    @Test("External entry points only see visible, online, primary-toggleable devices")
    @MainActor
    func controllableDevices() async throws {
        let (store, _) = try await makeStore()
        #expect(store.controllableDevices.map(\.id) == [Self.studyLight.id])
    }
}
