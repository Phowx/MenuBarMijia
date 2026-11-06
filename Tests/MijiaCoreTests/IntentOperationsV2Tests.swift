import Foundation
import Testing
@testable import MijiaCore

/// 方案 v1 第 2 步：相对调节（再暗一点 / 调高两度）、风扇档位与摇头。
struct IntentOperationsV2Tests {
    static let bedside = SmartDevice(
        id: "dev_bedside", name: "主卧床头灯", roomId: "zhu_wo", roomName: "主卧",
        model: "yeelink.light.bslamp2", isOnline: true,
        kind: .light(LightSpec(entityId: "light.bedside", isOn: true, brightnessPercent: 80))
    )
    static let studyDesk = SmartDevice(
        id: "dev_study_desk", name: "书房台灯", roomId: "shu_fang", roomName: "书房",
        model: "yeelink.light.lamp4", isOnline: true,
        kind: .light(LightSpec(entityId: "light.study_desk", isOn: false))
    )
    static let livingAC = SmartDevice(
        id: "dev_living_ac", name: "客厅空调", roomId: "ke_ting", roomName: "客厅",
        model: "xiaomi.aircondition.mt0", isOnline: true,
        kind: .climate(ClimateSpec(
            entityId: "climate.living_ac", isOn: true, hvacMode: "cool",
            availableModes: ["off", "cool", "heat"], targetTemperature: 26,
            minTemp: 16, maxTemp: 30,
            fanMode: "auto", availableFanModes: ["auto", "low", "medium", "high"]
        ))
    )
    static let fan = SmartDevice(
        id: "dev_fan", name: "客厅风扇", roomId: "ke_ting", roomName: "客厅",
        model: "dmaker.fan.p5", isOnline: true,
        kind: .fan(FanSpec(
            entityId: "fan.living", isOn: true, presetMode: "Level1",
            availablePresetModes: ["Level1", "Level2", "Level3"], isOscillating: false
        ))
    )
    static let devices = [bedside, studyDesk, livingAC, fan]

    // MARK: - 相对亮度

    @Test("Brightness steps clamp to 1...100 and start from 0 when the light is off")
    func brightnessStepClamps() {
        #expect(IntentValidator.normalize(.brightnessStep(-200), for: Self.bedside) == .brightness(1))
        #expect(IntentValidator.normalize(.brightnessStep(30), for: Self.studyDesk) == .brightness(30))
        #expect(IntentValidator.normalize(.brightnessStep(10), for: Self.livingAC) == nil)
    }

    // MARK: - 相对温度

    // MARK: - 风扇档位与摇头

    @Test("Fan speed words map onto the device's own preset list by rank")
    func fanSpeedByRank() throws {
        #expect(IntentValidator.normalize(.fanSpeed("high"), for: Self.fan) == .fanSpeed("Level3"))
        #expect(IntentValidator.normalize(.fanSpeed("低"), for: Self.fan) == .fanSpeed("Level1"))
        #expect(IntentValidator.normalize(.fanSpeed("medium"), for: Self.fan) == .fanSpeed("Level2"))
        #expect(IntentValidator.normalize(.fanSpeed("Level2"), for: Self.fan) == .fanSpeed("Level2"))
        #expect(IntentValidator.normalize(.fanSpeed("high"), for: Self.livingAC) == .fanSpeed("high"))
        #expect(IntentValidator.normalize(.fanSpeed("自动"), for: Self.livingAC) == .fanSpeed("auto"))
        #expect(IntentValidator.normalize(.fanSpeed("turbo"), for: Self.fan) == nil)

    }

    // MARK: - 大模型输出

    // MARK: - 执行

    @Test("Structured actions dispatch fan speed and oscillation commands")
    @MainActor
    func dispatchFanCommands() async throws {
        let provider = MockHomeProvider(snapshot: SynthesizedHome(devices: Self.devices, scenes: []))
        let store = HomeStore(provider: provider, defaultsSuiteName: "test.v2.\(UUID().uuidString)")
        for _ in 0..<50 where store.devices.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        _ = await store.runAutomation(intents: [.init(targetId: Self.fan.id, operation: .fanSpeed("high"))], title: "风扇调到高档")
        _ = await store.runAutomation(intents: [.init(targetId: Self.fan.id, operation: .oscillation(true))], title: "风扇摇头")
        let sent = await provider.executedCommands
        #expect(sent.contains(.setFanPresetMode(entityId: "fan.living", presetMode: "Level3")))
        #expect(sent.contains(.setFanOscillating(entityId: "fan.living", oscillating: true)))
    }
}
