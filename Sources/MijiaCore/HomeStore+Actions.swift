import Foundation

// Shared execution for explicit device actions and Mac-state automation.
extension HomeStore {
    @discardableResult
    func executeIntentPlan(_ plan: IntentPlan, undoDuration: TimeInterval? = nil) async -> IntentPlan {
        let context = controlContextID
        let previousSnapshot = devices
        var order: [String] = []
        var groups: [String: [DeviceIntent]] = [:]
        for intent in plan.intents {
            if groups[intent.targetId] == nil { order.append(intent.targetId) }
            groups[intent.targetId, default: []].append(intent)
        }
        let tasks = order.map { target in
            let intents = groups[target] ?? []
            return Task { () -> [DeviceApplyOutcome] in
                var outcomes: [DeviceApplyOutcome] = []
                for intent in intents {
                    guard context == self.controlContextID else { break }
                    outcomes.append(await self.apply(intent, context: context))
                }
                return outcomes
            }
        }
        var outcomes: [DeviceApplyOutcome] = []
        for task in tasks { outcomes.append(contentsOf: await task.value) }
        guard context == controlContextID else { return plan }
        var restore: [DeviceCommand] = []
        var changed: Set<String> = []
        var failures: [String] = []
        var succeeded = false
        for outcome in outcomes {
            switch outcome {
            case .applied(let id, let commands):
                succeeded = true
                restore.append(contentsOf: commands)
                if let id { changed.insert(id) }
            case .appliedScene:
                succeeded = true
            case .failed(let name), .offline(let name):
                if !failures.contains(name) { failures.append(name) }
            case .skipped: break
            }
        }
        if !restore.isEmpty {
            scheduleUndoBanner(
                title: plan.reply,
                restoreCommands: Array(restore.reversed()),
                previousDevices: previousSnapshot,
                deviceCount: changed.count,
                duration: undoDuration
            )
        }
        if !failures.isEmpty {
            showToast(L10n.tr("以下设备未响应或已离线：", "Unavailable or failed devices: ") + failures.joined(separator: L10n.tr("、", ", ")), isError: true)
        } else if succeeded {
            showToast(plan.reply)
        } else {
            showToast(L10n.tr("没有可执行的设备操作", "No matching device actions"), isError: true)
        }
        return plan
    }

    private enum DeviceApplyOutcome: Sendable {
        case applied(deviceId: String?, restore: [DeviceCommand])
        /// Scenes have no general inverse operation.
        case appliedScene(sceneId: String)
        case failed(String)
        case offline(String)
        case skipped
    }

    private struct DeviceEffect {
        let updated: SmartDevice
        let command: DeviceCommand
        let restore: [DeviceCommand]
    }

    /// Structured device actions use optimistic state, dispatch and rollback without language parsing.
    private func apply(_ intent: DeviceIntent, context: UUID) async -> DeviceApplyOutcome {
        guard context == controlContextID else { return .skipped }
        if intent.operation == .activateScene {
            guard let scene = scenes.first(where: { $0.id == intent.targetId }) else { return .skipped }
            do {
                try await executeDeviceCommand(.activateScene(entityId: scene.entityId))
                guard context == controlContextID else { return .skipped }
                return .appliedScene(sceneId: intent.targetId)
            } catch {
                return .failed(scene.name)
            }
        }

        guard let idx = devices.firstIndex(where: { $0.id == intent.targetId }) else { return .skipped }
        let previous = devices[idx]
        guard previous.isOnline else { return .offline(previous.name) }
        guard let effect = Self.deviceEffect(of: intent.operation, on: previous) else { return .skipped }

        if !previous.isMomentaryButton {
            devices[idx] = effect.updated
            lockOptimistic(previous.id, duration: .seconds(3.0))
        }
        do {
            try await executeDeviceCommand(effect.command)
            guard context == controlContextID else { return .skipped }
            return .applied(deviceId: previous.isMomentaryButton ? nil : previous.id, restore: effect.restore)
        } catch {
            guard context == controlContextID else { return .skipped }
            if !previous.isMomentaryButton {
                if let revertIdx = devices.firstIndex(where: { $0.id == previous.id }) {
                    devices[revertIdx] = previous
                }
                optimisticLockUntil.removeValue(forKey: previous.id)
            }
            return .failed(previous.name)
        }
    }

    static func undoEffect(of command: DeviceCommand, on device: SmartDevice) -> SmartDevice? {
        let operation: IntentOperation
        switch command {
        case .setLightPower(_, let on), .setFanPower(_, let on), .setSwitch(_, let on): operation = .power(on)
        case .setLightBrightness(_, let percent): operation = .brightness(percent)
        case .setLightColorTemp(_, let kelvin): operation = .colorTemperature(kelvin)
        case .setLightEffect(_, let effect): operation = .lightEffect(effect)
        case .setClimatePower(_, let on, let mode): operation = .hvacMode(on ? mode : "off")
        case .setClimateMode(_, let mode): operation = .hvacMode(mode)
        case .setClimateTemperature(_, let temperature): operation = .targetTemperature(temperature)
        case .setClimateFanMode(_, let mode), .setFanPresetMode(_, let mode): operation = .fanSpeed(mode)
        case .setFanOscillating(_, let on): operation = .oscillation(on)
        case .vacuumAction(_, .start): operation = .power(true)
        case .vacuumAction(_, .returnToBase): operation = .power(false)
        default: return nil
        }
        guard let effect = deviceEffect(of: operation, on: device),
              effect.command.targetEntityId == command.targetEntityId else { return nil }
        if case .setClimatePower = command { return effect.updated }
        guard effect.command == command else { return nil }
        return effect.updated
    }

    private static func deviceEffect(of operation: IntentOperation, on device: SmartDevice) -> DeviceEffect? {
        guard let op = IntentValidator.normalize(operation, for: device) else { return nil }
        var updated = device

        switch (op, device.kind) {
        case (.power(let on), .light(var s)):
            let restore = DeviceCommand.setLightPower(entityId: s.entityId, isOn: s.isOn)
            s.isOn = on
            updated.kind = .light(s)
            return DeviceEffect(updated: updated, command: .setLightPower(entityId: s.entityId, isOn: on), restore: [restore])

        case (.brightness(let percent), .light(var s)):
            var restore: [DeviceCommand] = []
            if !s.isOn { restore.append(.setLightPower(entityId: s.entityId, isOn: false)) }
            if let previous = s.brightnessPercent {
                restore.append(.setLightBrightness(entityId: s.entityId, percent: previous))
            } else if s.isOn {
                restore.append(.setLightBrightness(entityId: s.entityId, percent: 100))
            }
            s.isOn = true
            s.brightnessPercent = percent
            updated.kind = .light(s)
            return DeviceEffect(updated: updated, command: .setLightBrightness(entityId: s.entityId, percent: percent), restore: restore)

        case (.colorTemperature(let kelvin), .light(var s)):
            var restore: [DeviceCommand] = []
            if !s.isOn { restore.append(.setLightPower(entityId: s.entityId, isOn: false)) }
            if let prevKelvin = s.colorTempKelvin {
                if let effect = s.currentEffect { restore.append(.setLightEffect(entityId: s.entityId, effect: effect)) }
                restore.append(.setLightColorTemp(entityId: s.entityId, kelvin: prevKelvin))
            } else if s.isOn {
                restore.append(.setLightPower(entityId: s.entityId, isOn: true))
            }
            s.isOn = true
            s.colorTempKelvin = kelvin
            s.currentEffect = nil
            updated.kind = .light(s)
            return DeviceEffect(updated: updated, command: .setLightColorTemp(entityId: s.entityId, kelvin: kelvin), restore: restore)

        case (.lightEffect(let effect), .light(var s)):
            var restore: [DeviceCommand] = []
            if !s.isOn { restore.append(.setLightPower(entityId: s.entityId, isOn: false)) }
            if let prevEffect = s.currentEffect {
                restore.append(.setLightEffect(entityId: s.entityId, effect: prevEffect))
            } else if let prevKelvin = s.colorTempKelvin {
                restore.append(.setLightColorTemp(entityId: s.entityId, kelvin: prevKelvin))
            } else if s.isOn {
                restore.append(.setLightPower(entityId: s.entityId, isOn: true))
            }
            s.isOn = true
            s.currentEffect = effect
            updated.kind = .light(s)
            return DeviceEffect(
                updated: updated,
                command: .setLightEffect(entityId: s.entityId, effect: effect),
                restore: restore
            )

        case (.power(let on), .climate(var s)):
            let wasOn = s.isOn && s.hvacMode != "off"
            let resumeMode = s.hvacMode == "off" ? (s.availableModes.first(where: { $0 != "off" }) ?? "heat") : s.hvacMode
            let restore = DeviceCommand.setClimatePower(entityId: s.entityId, isOn: wasOn, fallbackMode: resumeMode)
            s.isOn = on
            s.hvacMode = on ? resumeMode : "off"
            updated.kind = .climate(s)
            return DeviceEffect(
                updated: updated,
                command: .setClimatePower(entityId: s.entityId, isOn: on, fallbackMode: resumeMode),
                restore: [restore]
            )

        case (.hvacMode(let mode), .climate(var s)):
            let restore = DeviceCommand.setClimateMode(entityId: s.entityId, hvacMode: s.isOn ? s.hvacMode : "off")
            s.hvacMode = mode
            s.isOn = (mode != "off")
            updated.kind = .climate(s)
            return DeviceEffect(updated: updated, command: .setClimateMode(entityId: s.entityId, hvacMode: mode), restore: [restore])

        case (.targetTemperature(let temperature), .climate(var s)):
            let restore = DeviceCommand.setClimateTemperature(entityId: s.entityId, temperature: s.targetTemperature)
            s.targetTemperature = temperature
            updated.kind = .climate(s)
            return DeviceEffect(
                updated: updated,
                command: .setClimateTemperature(entityId: s.entityId, temperature: temperature),
                restore: [restore]
            )

        case (.power(let on), .fan(var s)):
            let restore = DeviceCommand.setFanPower(entityId: s.entityId, isOn: s.isOn)
            s.isOn = on
            updated.kind = .fan(s)
            return DeviceEffect(updated: updated, command: .setFanPower(entityId: s.entityId, isOn: on), restore: [restore])

        case (.power(let on), .plug(var s)):
            if s.switchEntityId.hasPrefix("button.") {
                guard on else { return nil }
                return DeviceEffect(updated: updated, command: .pressButton(entityId: s.switchEntityId), restore: [])
            }
            let restore = DeviceCommand.setSwitch(entityId: s.switchEntityId, isOn: s.isOn)
            s.isOn = on
            updated.kind = .plug(s)
            return DeviceEffect(updated: updated, command: .setSwitch(entityId: s.switchEntityId, isOn: on), restore: [restore])

        case (.power(let on), .vacuum(var s)):
            let restore = DeviceCommand.vacuumAction(entityId: s.entityId, action: s.isCleaning ? .start : .returnToBase)
            s.status = on ? "cleaning" : "returning"
            updated.kind = .vacuum(s)
            return DeviceEffect(
                updated: updated,
                command: .vacuumAction(entityId: s.entityId, action: on ? .start : .returnToBase),
                restore: [restore]
            )

        case (.power(let on), .tv(var s)):
            let wasOn = s.state != "off" && s.state != "standby"
            let powerEntity = LGWebOSProtocol.isLGEntity(s.mediaEntityId) ? LGWebOSProtocol.powerEntityId : s.mediaEntityId
            let restore = DeviceCommand.setSwitch(entityId: powerEntity, isOn: wasOn)
            s.state = on ? "on" : "standby"
            if on { s.isScreenOff = false }
            updated.kind = .tv(s)
            return DeviceEffect(
                updated: updated,
                command: .setSwitch(entityId: powerEntity, isOn: on),
                restore: [restore]
            )


        case (.power(let on), .camera(var s)):
            let restore = DeviceCommand.setSwitch(entityId: s.entityId, isOn: s.isOn)
            s.isOn = on
            updated.kind = .camera(s)
            return DeviceEffect(
                updated: updated,
                command: .setSwitch(entityId: s.entityId, isOn: on),
                restore: [restore]
            )
        case (.fanSpeed(let preset), .fan(var s)):
            var restore: [DeviceCommand] = []
            if !s.isOn { restore.append(.setFanPower(entityId: s.entityId, isOn: false)) }
            if let previous = s.presetMode {
                restore.append(.setFanPresetMode(entityId: s.entityId, presetMode: previous))
            } else if s.isOn {
                restore.append(.setFanPower(entityId: s.entityId, isOn: true))
            }
            s.isOn = true
            s.presetMode = preset
            updated.kind = .fan(s)
            return DeviceEffect(updated: updated, command: .setFanPresetMode(entityId: s.entityId, presetMode: preset), restore: restore)

        case (.fanSpeed(let fanMode), .climate(var s)):
            let restore = s.fanMode.map { [DeviceCommand.setClimateFanMode(entityId: s.entityId, fanMode: $0)] } ?? []
            s.fanMode = fanMode
            updated.kind = .climate(s)
            return DeviceEffect(updated: updated, command: .setClimateFanMode(entityId: s.entityId, fanMode: fanMode), restore: restore)

        case (.oscillation(let on), .fan(var s)):
            let restore = DeviceCommand.setFanOscillating(entityId: s.entityId, oscillating: s.isOscillating ?? !on)
            s.isOscillating = on
            updated.kind = .fan(s)
            return DeviceEffect(updated: updated, command: .setFanOscillating(entityId: s.entityId, oscillating: on), restore: [restore])

        default:
            return nil
        }
    }

}
