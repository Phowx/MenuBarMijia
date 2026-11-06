import Foundation

// MARK: - Structured Device Actions

public enum IntentOperation: Codable, Equatable, Sendable {
    case power(Bool)
    case brightness(Int)          // 1...100
    case colorTemperature(Int)    // kelvin
    case lightEffect(String)      // Day / Night (or device-supported effect)
    case hvacMode(String)         // cool/heat/dry/fan_only/auto/off
    case targetTemperature(Double)
    case activateScene            // target is a HomeScene id
    case fanSpeed(String)         // fan preset or air-conditioner fan mode; normalized to the device's own option
    case oscillation(Bool)        // fan swing (摇头)

    // Relative adjustments from structured controls. IntentValidator.normalize resolves them against the
    // device's current state into .brightness / .targetTemperature, so nothing downstream ever sees them.
    case brightnessStep(Int)      // ± percent
    case temperatureStep(Double)  // ± °C

    public var isRelative: Bool {
        switch self {
        case .brightnessStep, .temperatureStep: return true
        default: return false
        }
    }
}

public struct DeviceIntent: Codable, Equatable, Sendable {
    public let targetId: String
    public let operation: IntentOperation

    public init(targetId: String, operation: IntentOperation) {
        self.targetId = targetId
        self.operation = operation
    }
}

public struct IntentPlan: Codable, Equatable, Sendable {
    public var intents: [DeviceIntent]
    public var reply: String

    public init(intents: [DeviceIntent], reply: String) {
        self.intents = intents
        self.reply = reply
    }
}

// MARK: - Device Category

public enum IntentDeviceCategory: String, Equatable, Sendable, CaseIterable {
    case light, climate, heater, fan, airPurifier, plug, vacuum, speaker, tv, fridge, camera, sensor
    private static let heaterNameHints = ["电暖", "暖气", "取暖", "暖风"]
    private static let airPurifierNameHints = ["净化", "空净"]

    public init(_ device: SmartDevice) {
        switch device.kind {
        case .light: self = .light
        case .climate:
            let isHeater = device.model.contains("heater")
                || Self.heaterNameHints.contains(where: device.name.contains)
            self = isHeater ? .heater : .climate
        case .fan(let s):
            let lowerModel = device.model.lowercased()
            let isPurifier = lowerModel.contains("airp")
                || lowerModel.contains("purifier")
                || Self.airPurifierNameHints.contains(where: device.name.contains)
                || s.pm25Density != nil
                || s.airQuality != nil
                || s.filterLifePercent != nil
            self = isPurifier ? .airPurifier : .fan
        case .plug: self = .plug
        case .vacuum: self = .vacuum
        case .speaker: self = .speaker
        case .tv: self = .tv
        case .fridge: self = .fridge
        case .camera: self = .camera
        case .sensor: self = .sensor
        }
    }

}

// MARK: - Device Action Validation

public enum IntentValidator {
    private static let hvacModeAliases: [String: String] = [
        "fan": "fan_only",
        "fanonly": "fan_only",
        "heat_cool": "auto"
    ]

    private static let lightEffectAliases: [String: String] = [
        "moonlight": "Night",
        "night": "Night",
        "月光": "Night",
        "月光模式": "Night",
        "夜灯": "Night",
        "夜灯模式": "Night",
        "daylight": "Day",
        "day": "Day",
        "日光": "Day",
        "日光模式": "Day"
    ]

    /// Returns the operation adjusted to the device's limits, or nil when the device cannot perform it.
    public static func normalize(_ operation: IntentOperation, for device: SmartDevice) -> IntentOperation? {
        switch (operation, device.kind) {
        case (.power, .light), (.power, .climate), (.power, .fan), (.power, .plug), (.power, .vacuum), (.power, .tv), (.power, .camera):
            return operation

        case (.brightness(let percent), .light):
            return .brightness(min(100, max(1, percent)))

        case (.colorTemperature(let kelvin), .light(let s)):
            guard kelvin > 0 else { return nil }
            return .colorTemperature(min(s.maxKelvin, max(s.minKelvin, kelvin)))

        case (.lightEffect(let raw), .light(let s)):
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let canonical = lightEffectAliases[trimmed.lowercased()] ?? lightEffectAliases[trimmed] ?? trimmed
            guard let matched = s.availableEffects.first(where: {
                $0.caseInsensitiveCompare(canonical) == .orderedSame
            }) else {
                return nil
            }
            return .lightEffect(matched)

        case (.hvacMode(let raw), .climate(let s)):
            let lowered = raw.lowercased()
            let mode = hvacModeAliases[lowered] ?? lowered
            if mode == "off" || s.availableModes.isEmpty || s.availableModes.contains(mode) {
                return .hvacMode(mode)
            }
            // HA climate entities expose "heat_cool" where users say "auto".
            if mode == "auto", s.availableModes.contains("heat_cool") {
                return .hvacMode("heat_cool")
            }
            return nil

        case (.targetTemperature(let t), .climate(let s)):
            guard t.isFinite else { return nil }
            return .targetTemperature(min(s.maxTemp, max(s.minTemp, t)))

        case (.brightnessStep(let delta), .light(let s)):
            let base = s.isOn ? (s.brightnessPercent ?? 100) : 0
            return .brightness(min(100, max(1, base + delta)))

        case (.temperatureStep(let delta), .climate(let s)):
            guard delta.isFinite else { return nil }
            return .targetTemperature(min(s.maxTemp, max(s.minTemp, s.targetTemperature + delta)))

        case (.fanSpeed(let raw), .fan(let s)):
            return FanSpeedMatcher.match(raw, in: s.availablePresetModes).map(IntentOperation.fanSpeed)

        case (.fanSpeed(let raw), .climate(let s)):
            return FanSpeedMatcher.match(raw, in: s.availableFanModes).map(IntentOperation.fanSpeed)

        // 「自动模式」 parses as hvacMode(auto); on a fan that means its Auto preset,
        // not an HVAC mode (#98).
        case (.hvacMode(let raw), .fan(let s)) where raw.lowercased() == "auto":
            return FanSpeedMatcher.match("auto", in: s.availablePresetModes).map(IntentOperation.fanSpeed)

        case (.oscillation, .fan(let s)) where s.isOscillating != nil:
            return operation

        default:
            return nil
        }
    }

    /// Keeps only intents whose target exists and whose operation is valid for it, clamping numeric values.
    public static func sanitize(
        _ intents: [DeviceIntent],
        devices: [SmartDevice],
        scenes: [HomeScene]
    ) -> [DeviceIntent] {
        let deviceById = Dictionary(devices.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let sceneIds = Set(scenes.map(\.id))
        var result: [DeviceIntent] = []
        for intent in intents {
            if intent.operation == .activateScene {
                if sceneIds.contains(intent.targetId) { result.append(intent) }
                continue
            }
            guard let device = deviceById[intent.targetId],
                  let op = normalize(intent.operation, for: device) else { continue }
            let normalized = DeviceIntent(targetId: device.id, operation: op)
            if !result.contains(normalized) { result.append(normalized) }
        }
        return result
    }
}

// MARK: - Human-Readable Receipts

public enum IntentReply {
    public static func describe(
        _ intents: [DeviceIntent],
        devices: [SmartDevice],
        scenes: [HomeScene]
    ) -> String {
        let nameById = Dictionary(
            devices.map { ($0.id, $0.name) } + scenes.map { ($0.id, $0.name) },
            uniquingKeysWith: { first, _ in first }
        )
        let momentaryIds = Set(devices.filter(\.isMomentaryButton).map(\.id))
        var order: [(key: String, op: IntentOperation, isMomentaryTrigger: Bool)] = []
        var targetsByOp: [String: [String]] = [:]
        for intent in intents {
            let isMomentaryTrigger: Bool = {
                if case .power(true) = intent.operation, momentaryIds.contains(intent.targetId) {
                    return true
                }
                return false
            }()
            let key = isMomentaryTrigger ? "momentaryTrigger" : String(describing: intent.operation)
            if targetsByOp[key] == nil { order.append((key, intent.operation, isMomentaryTrigger)) }
            targetsByOp[key, default: []].append(nameById[intent.targetId] ?? intent.targetId)
        }
        let isEn = L10n.isEnglish
        let clauses = order.map { entry -> String in
            let op = entry.op
            let names = targetsByOp[entry.key] ?? []
            let sep = isEn ? ", " : "、"
            let joined = names.count > 3
                ? names.prefix(3).joined(separator: sep) + L10n.format(
                    " 等 %@ 台", " (+%@ more)", String(isEn ? names.count - 3 : names.count)
                )
                : names.joined(separator: sep)
            if entry.isMomentaryTrigger {
                return L10n.format("触发%@", "Triggered %@", joined)
            }
            switch op {
            case .power(true): return L10n.format("打开%@", "Turned on %@", joined)
            case .power(false): return L10n.format("关闭%@", "Turned off %@", joined)
            case .brightness(let b): return L10n.format("%@亮度调至 %@%", "Set %@ brightness to %@%", joined, String(b))
            case .colorTemperature(let k): return L10n.format("%@色温调至 %@K", "Set %@ color temp to %@K", joined, String(k))
            case .lightEffect(let e):
                return L10n.format("%@切换为%@模式", "Switched %@ to %@ mode", joined, SmartDevice.localizeEffect(e))
            case .hvacMode(let m):
                return L10n.format("%@切换为%@", "Switched %@ to %@", joined, SmartDevice.localizeHVACMode(m))
            case .targetTemperature(let t):
                let temperature = formatTemperature(L10n.temperatureNumber(t)) + L10n.temperatureSymbol
                return L10n.format("%@设为 %@", "Set %@ to %@", joined, temperature)
            case .activateScene: return L10n.format("执行场景「%@」", "Activated scene \"%@\"", joined)
            case .fanSpeed(let v):
                let label = fanSpeedLabel(v)
                let spaced = !isEn && label.first?.isNumber == true ? " " + label : label
                return L10n.format("%@风速调为%@", "Set %@ fan speed to %@", joined, spaced)
            case .oscillation(let on):
                return on
                    ? L10n.format("%@开启摇头", "Enabled oscillation on %@", joined)
                    : L10n.format("%@关闭摇头", "Disabled oscillation on %@", joined)
            case .brightnessStep(let d):
                return d >= 0
                    ? L10n.format("%@亮度调高 %@%", "Increased %@ brightness by %@%", joined, String(abs(d)))
                    : L10n.format("%@亮度调低 %@%", "Decreased %@ brightness by %@%", joined, String(abs(d)))
            case .temperatureStep(let d):
                let delta = L10n.temperatureUnit == .fahrenheit ? abs(d) * 9 / 5 : abs(d)
                let temperature = formatTemperature(delta) + L10n.temperatureSymbol
                return d >= 0
                    ? L10n.format("%@温度调高 %@", "Increased %@ temp by %@", joined, temperature)
                    : L10n.format("%@温度调低 %@", "Decreased %@ temp by %@", joined, temperature)
            }
        }
        if clauses.isEmpty { return "" }
        return isEn ? clauses.joined(separator: "; ") : L10n.tr("已", "") + clauses.joined(separator: "，")
    }

    /// "Level3" → "3 档"，"high" → "高档"；其余原样返回。
    public static func fanSpeedLabel(_ raw: String) -> String {
        let lowered = raw.lowercased()
        if lowered.hasPrefix("level"), let n = Int(lowered.dropFirst(5)) {
            return L10n.format("%@ 档", "Level %@", String(n))
        }
        switch lowered {
        case "low": return L10n.tr("低档", "Low")
        case "medium", "middle", "mid": return L10n.tr("中档", "Medium")
        case "high": return L10n.tr("高档", "High")
        case "auto": return L10n.tr("自动", "Auto")
        case "silent": return L10n.tr("静音", "Silent")
        case "sleep": return L10n.tr("睡眠", "Sleep")
        case "favorite", "favourite": return L10n.tr("最爱", "Favorite")
        case "manual": return L10n.tr("手动", "Manual")
        default: return raw
        }
    }

    static func formatTemperature(_ t: Double) -> String {
        t.rounded() == t ? String(Int(t)) : String(format: "%.1f", t)
    }
}

// MARK: - Fan Speed Matching

/// Maps structured speed labels (高/中/低/自动, high/medium/low/auto) onto whatever option names the device
/// exposes ("Level1…3", "low/medium/high", "静音"…). Exact names win; otherwise rank among the plain
/// speed levels (first = low, middle = medium, last = high).
public enum FanSpeedMatcher {
    private enum Level { case low, medium, high, auto, sleep, favorite }

    private static let speedAliases: [(Level, [String])] = [
        (.auto, ["auto", "自动"]),
        (.sleep, ["sleep", "睡眠", "silent", "静音"]),
        (.favorite, ["favorite", "favourite", "最爱", "manual", "手动"]),
        (.high, ["high", "高", "大", "强", "max", "最大", "strong"]),
        (.medium, ["medium", "middle", "mid", "中"]),
        (.low, ["low", "低", "小", "弱", "min", "最小", "微"])
    ]
    private static let optionHints: [Level: [String]] = [
        .auto: ["auto", "自动"],
        .sleep: ["sleep", "睡眠", "silent", "静音"],
        .favorite: ["favorite", "favourite", "最爱", "manual", "手动"],
        .high: ["high", "strong", "高", "强"],
        .medium: ["medium", "middle", "mid", "中"],
        .low: ["low", "低", "弱"]
    ]
    /// Options that are modes rather than speed levels, so they never take part in rank matching.
    private static let nonLevelHints = ["auto", "自动", "sleep", "睡眠", "silent", "静音", "natural", "nature", "自然", "smart", "智能", "favorite", "favourite", "最爱"]

    public static func match(_ raw: String, in options: [String]) -> String? {
        let wanted = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wanted.isEmpty, !options.isEmpty else { return nil }
        if let exact = options.first(where: { $0.caseInsensitiveCompare(wanted) == .orderedSame }) { return exact }

        let lowered = wanted.lowercased()
        guard let level = speedAliases.first(where: { $0.1.contains(where: { lowered == $0 || lowered.hasPrefix($0) }) })?.0 else {
            return nil
        }
        if let named = options.first(where: { opt in optionHints[level]!.contains { opt.lowercased().contains($0) } }) {
            return named
        }
        let levels = options.filter { opt in !nonLevelHints.contains { opt.lowercased().contains($0) } }
        guard !levels.isEmpty else { return nil }
        switch level {
        case .low: return levels.first
        case .high: return levels.last
        case .medium: return levels[levels.count / 2]
        case .auto, .sleep, .favorite: return nil
        }
    }
}
