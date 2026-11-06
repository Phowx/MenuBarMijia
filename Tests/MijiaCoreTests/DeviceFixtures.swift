import Foundation
import Testing
@testable import MijiaCore

enum DeviceFixtures {
    // MARK: - Fixture

    static let studyCeiling = SmartDevice(
        id: "dev_study_ceiling", name: "书房吸顶灯", roomId: "shu_fang", roomName: "书房",
        model: "yeelink.light.ceiling20", isOnline: true,
        kind: .light(LightSpec(
            entityId: "light.study_ceiling",
            isOn: false,
            availableEffects: ["Day", "Night"]
        ))
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
            entityId: "climate.living_ac", isOn: false, hvacMode: "off",
            availableModes: ["off", "cool", "heat", "dry", "fan_only", "auto"],
            targetTemperature: 24
        ))
    )
    static let bedsideLamp = SmartDevice(
        id: "dev_bedside", name: "主卧床头灯", roomId: "zhu_wo", roomName: "主卧",
        model: "yeelink.light.bslamp2", isOnline: true,
        kind: .light(LightSpec(entityId: "light.bedside", isOn: true, brightnessPercent: 80))
    )
    static let guestHeater = SmartDevice(
        id: "dev_guest_heater", name: "次卧电暖器", roomId: "ci_wo", roomName: "次卧",
        model: "zhimi.heater.za2", isOnline: true,
        kind: .climate(ClimateSpec(
            entityId: "climate.guest_heater", isOn: false, hvacMode: "off",
            availableModes: ["off", "heat"], targetTemperature: 20
        ))
    )
    static let devices = [studyCeiling, studyDesk, livingAC, bedsideLamp, guestHeater]
    static let scenes = [
        HomeScene(id: "scene_home", name: "回家模式", entityId: "scene.home"),
        HomeScene(id: "scene_sleep", name: "睡眠模式", entityId: "scene.sleep")
    ]

}
