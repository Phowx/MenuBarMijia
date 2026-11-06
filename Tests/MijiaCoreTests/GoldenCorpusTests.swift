import Foundation
import Testing
@testable import MijiaCore

struct GoldenCorpusTests {

    private struct CorpusDevice: Decodable {
        let id: String
        let name: String
        let roomId: String
        let roomName: String
        let model: String
        let isOnline: Bool
        let kind: CorpusKind

        func toSmartDevice() -> SmartDevice {
            SmartDevice(
                id: id,
                name: name,
                roomId: roomId,
                roomName: roomName,
                model: model,
                isOnline: isOnline,
                kind: kind.toDeviceKind()
            )
        }
    }

    private enum CorpusKind: Decodable {
        case light(LightPayload)
        case climate(ClimatePayload)
        case fan(FanPayload)
        case plug(PlugPayload)
        case vacuum(VacuumPayload)
        case camera(CameraPayload)
        case sensor(SensorPayload)
        private enum CodingKeys: String, CodingKey { case kind }

        struct LightPayload: Decodable {
            let entityId: String
            let isOn: Bool
            let brightnessPercent: Int?
            let colorTempKelvin: Int?
            let minKelvin: Int
            let maxKelvin: Int
            let currentEffect: String?
            let availableEffects: [String]
        }

        struct ClimatePayload: Decodable {
            let entityId: String
            let isOn: Bool
            let hvacMode: String
            let availableModes: [String]
            let targetTemperature: Double
            let currentTemperature: Double?
            let minTemp: Double
            let maxTemp: Double
            let step: Double
            let fanMode: String?
            let availableFanModes: [String]
            let swingMode: String?
            let availableSwingModes: [String]?
        }

        struct FanPayload: Decodable {
            let entityId: String
            let isOn: Bool
            let percentage: Int?
            let presetMode: String?
            let availablePresetModes: [String]
            let isOscillating: Bool?
            let pm25Density: Int?
            let airQuality: String?
            let temperature: Double?
            let humidity: Double?
            let filterLifePercent: Int?
        }

        struct PlugPayload: Decodable {
            let switchEntityId: String
            let isOn: Bool
            let powerWatts: Double?
            let energyKwh: Double?
            let childLockEntityId: String?
            let isChildLocked: Bool
        }

        struct VacuumPayload: Decodable {
            let entityId: String
            let status: String
            let battery: Int?
            let modeEntityId: String?
            let currentMode: String?
            let availableModes: [String]
        }

        struct CameraPayload: Decodable {
            let entityId: String
            let isOn: Bool
            let nightShot: String?
            let availableNightShots: [String]
            let motionDetectionEntityId: String?
            let isMotionDetectionOn: Bool?
            let streamEntityId: String?
            let snapshotPath: String?
        }

        struct SensorPayload: Decodable {
            let temperature: Double?
            let humidity: Double?
            let battery: Int?
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let kind = try container.decode(String.self, forKey: .kind)
            switch kind {
            case "light":
                self = .light(try LightPayload(from: decoder))
            case "climate":
                self = .climate(try ClimatePayload(from: decoder))
            case "fan":
                self = .fan(try FanPayload(from: decoder))
            case "plug":
                self = .plug(try PlugPayload(from: decoder))
            case "vacuum":
                self = .vacuum(try VacuumPayload(from: decoder))
            case "camera":
                self = .camera(try CameraPayload(from: decoder))
            case "sensor":
                self = .sensor(try SensorPayload(from: decoder))
            default:
                throw DecodingError.dataCorruptedError(
                    forKey: .kind,
                    in: container,
                    debugDescription: "Unknown device kind in golden corpus: \(kind)"
                )
            }
        }

        func toDeviceKind() -> DeviceKind {
            switch self {
            case .light(let p):
                return .light(
                    LightSpec(
                        entityId: p.entityId,
                        isOn: p.isOn,
                        brightnessPercent: p.brightnessPercent,
                        colorTempKelvin: p.colorTempKelvin,
                        minKelvin: p.minKelvin,
                        maxKelvin: p.maxKelvin,
                        currentEffect: p.currentEffect,
                        availableEffects: p.availableEffects
                    )
                )
            case .climate(let p):
                return .climate(
                    ClimateSpec(
                        entityId: p.entityId,
                        isOn: p.isOn,
                        hvacMode: p.hvacMode,
                        availableModes: p.availableModes,
                        targetTemperature: p.targetTemperature,
                        currentTemperature: p.currentTemperature,
                        minTemp: p.minTemp,
                        maxTemp: p.maxTemp,
                        step: p.step,
                        fanMode: p.fanMode,
                        availableFanModes: p.availableFanModes,
                        swingMode: p.swingMode,
                        availableSwingModes: p.availableSwingModes ?? []
                    )
                )
            case .fan(let p):
                return .fan(
                    FanSpec(
                        entityId: p.entityId,
                        isOn: p.isOn,
                        percentage: p.percentage,
                        presetMode: p.presetMode,
                        availablePresetModes: p.availablePresetModes,
                        isOscillating: p.isOscillating,
                        pm25Density: p.pm25Density,
                        airQuality: p.airQuality,
                        temperature: p.temperature,
                        humidity: p.humidity,
                        filterLifePercent: p.filterLifePercent
                    )
                )
            case .plug(let p):
                return .plug(
                    PlugSpec(
                        switchEntityId: p.switchEntityId,
                        isOn: p.isOn,
                        powerWatts: p.powerWatts,
                        energyKwh: p.energyKwh,
                        childLockEntityId: p.childLockEntityId,
                        isChildLocked: p.isChildLocked
                    )
                )
            case .vacuum(let p):
                return .vacuum(
                    VacuumSpec(
                        entityId: p.entityId,
                        status: p.status,
                        battery: p.battery,
                        modeEntityId: p.modeEntityId,
                        currentMode: p.currentMode,
                        availableModes: p.availableModes
                    )
                )
            case .camera(let p):
                return .camera(
                    CameraSpec(
                        entityId: p.entityId,
                        isOn: p.isOn,
                        nightShot: p.nightShot,
                        availableNightShots: p.availableNightShots,
                        motionDetectionEntityId: p.motionDetectionEntityId,
                        isMotionDetectionOn: p.isMotionDetectionOn,
                        streamEntityId: p.streamEntityId,
                        snapshotPath: p.snapshotPath
                    )
                )
            case .sensor(let p):
                return .sensor(
                    SensorSpec(
                        temperature: p.temperature,
                        humidity: p.humidity,
                        battery: p.battery
                    )
                )
            }
        }
    }

    private struct MiotCorpus: Decodable {
        let specs: [String: MiotDeviceSpec]
        let devices: [MiotDeviceEntry]
        let rooms: [MiotRoomEntry]
        let values: [MiotValueEntry]
        let expectedKinds: [String: CorpusKind]
        let expectedEnvironmentReadings: [MiotReadingEntry]
        let expectedRequiredProps: [String: [MiotKeyEntry]]
        let commandCases: [MiotCommandCase]
        let fallbackSpecs: [MiotFallbackEntry]
    }

    private struct MiotFallbackEntry: Decodable {
        let did: String
        let model: String
        let name: String
        let spec: MiotDeviceSpec
        let values: [MiotFallbackValueEntry]
        let expectedKind: CorpusKind
    }

    /// Fallback values are scoped to their entry's `did`, so unlike `MiotValueEntry`
    /// they carry no `did` key of their own.
    private struct MiotFallbackValueEntry: Decodable {
        let siid: Int
        let piid: Int
        let value: JSONValue
    }

    private struct MiotReadingEntry: Decodable {
        let id: String
        let label: String
        let roomName: String
        let temperature: Double?
        let humidity: Double?
        let battery: Int?

        func toEnvironmentReading() -> EnvironmentReading {
            EnvironmentReading(
                id: id,
                label: label,
                roomName: roomName,
                temperature: temperature,
                humidity: humidity,
                battery: battery
            )
        }
    }

    private struct MiotDeviceEntry: Decodable {
        let did: String
        let name: String
        let model: String
        let isOnline: Bool
        let splitParentDid: String?
        let splitSiid: Int?
    }

    private struct MiotRoomEntry: Decodable {
        let id: String
        let name: String
        let dids: [String]
    }

    private struct MiotValueEntry: Decodable {
        let did: String
        let siid: Int
        let piid: Int
        let value: JSONValue
    }

    private struct MiotKeyEntry: Decodable, Equatable {
        let did: String
        let siid: Int
        let piid: Int
    }

    private struct MiotCommandPayload: Decodable {
        let kind: String
        let entityId: String
        let isOn: Bool?
        let percent: Int?
        let kelvin: Int?
        let effect: String?
        let hvacMode: String?
        let temperature: Double?
        let fanMode: String?
        let presetMode: String?
        let oscillating: Bool?
        let option: String?
        let action: String?
        func toDeviceCommand() throws -> DeviceCommand {
            switch kind {
            case "setLightPower":
                return .setLightPower(entityId: entityId, isOn: isOn ?? false)
            case "setLightBrightness":
                return .setLightBrightness(entityId: entityId, percent: percent ?? 0)
            case "setLightColorTemp":
                return .setLightColorTemp(entityId: entityId, kelvin: kelvin ?? 4000)
            case "setLightEffect":
                return .setLightEffect(entityId: entityId, effect: effect ?? "")
            case "setClimateMode":
                return .setClimateMode(entityId: entityId, hvacMode: hvacMode ?? "off")
            case "setClimateTemperature":
                return .setClimateTemperature(entityId: entityId, temperature: temperature ?? 26)
            case "setClimateFanMode":
                return .setClimateFanMode(entityId: entityId, fanMode: fanMode ?? "")
            case "setFanPower":
                return .setFanPower(entityId: entityId, isOn: isOn ?? false)
            case "setFanPercentage":
                return .setFanPercentage(entityId: entityId, percent: percent ?? 0)
            case "setFanPresetMode":
                return .setFanPresetMode(entityId: entityId, presetMode: presetMode ?? "")
            case "setFanOscillating":
                return .setFanOscillating(entityId: entityId, oscillating: oscillating ?? false)
            case "setSwitch":
                return .setSwitch(entityId: entityId, isOn: isOn ?? false)
            case "setSelectOption":
                return .setSelectOption(entityId: entityId, option: option ?? "")
            case "vacuumAction":
                let vAction: VacuumAction = switch action {
                case "start": .start
                case "pause": .pause
                default: .returnToBase
                }
                return .vacuumAction(entityId: entityId, action: vAction)
            default:
                throw CocoaError(.coderInvalidValue)
            }
        }
    }

    private struct MiotExpectedWrite: Decodable {
        let kind: String
        let writes: [MiotValueEntry]?
        let call: MiotExpectedAction?

        func toMiotWrite() -> MiotWrite {
            if kind == "action", let c = call {
                return .action(MiotActionCall(did: c.did, siid: c.siid, aiid: c.aiid, inputs: c.inputs))
            }
            let props = (writes ?? []).map {
                MiotPropWrite(did: $0.did, siid: $0.siid, piid: $0.piid, value: $0.value)
            }
            return .setProps(props)
        }
    }

    private struct MiotExpectedAction: Decodable {
        let did: String
        let siid: Int
        let aiid: Int
        let inputs: [JSONValue]
    }

    private struct MiotCommandCase: Decodable {
        let model: String
        let command: MiotCommandPayload
        let expected: MiotExpectedWrite
    }

    private struct RegionCorpus: Decodable {
        let regions: [String]
    }

    private static func locateGoldenFixture(_ relativePath: String = "Tests/Fixtures/intent_golden.json") throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent(relativePath)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir.deleteLastPathComponent()
        }
        throw CocoaError(.fileNoSuchFile)
    }

    @Test("Cross-platform MIoT golden JSON corpus matches MijiaCore MiotSynthesizer and MiotCommandMapper")
    func miotGoldenCorpusParity() throws {
        let fixtureURL = try Self.locateGoldenFixture("Tests/Fixtures/miot_golden.json")
        let data = try Data(contentsOf: fixtureURL)
        let corpus = try JSONDecoder().decode(MiotCorpus.self, from: data)

        let records = corpus.devices.map {
            MiDeviceRecord(
                did: $0.did,
                name: $0.name,
                model: $0.model,
                isOnline: $0.isOnline,
                splitParentDid: $0.splitParentDid,
                splitSiid: $0.splitSiid
            )
        }
        let rooms = corpus.rooms.map {
            MiRoom(id: $0.id, name: $0.name, dids: $0.dids)
        }
        var values: [MiotPropKey: JSONValue] = [:]
        for v in corpus.values {
            values[MiotPropKey(did: v.did, siid: v.siid, piid: v.piid)] = v.value
        }

        let home = MiotSynthesizer.synthesize(
            devices: records,
            rooms: rooms,
            specs: corpus.specs,
            values: values
        )

        #expect(home.devices.count == corpus.expectedKinds.count)
        for (did, expectedKind) in corpus.expectedKinds {
            let dev = try #require(home.devices.first(where: { $0.id == did }), "Missing device \(did)")
            #expect(dev.kind == expectedKind.toDeviceKind(), "Mismatch on \(did)")
        }
        #expect(home.environmentReadings == corpus.expectedEnvironmentReadings.map { $0.toEnvironmentReading() })

        // Offline fallback specs are shared synthesis rules: the corpus pins the exact
        // spec (Windows additionally asserts inferFallbackSpec matches it) and both
        // platforms assert synthesis from it (#98).
        for entry in corpus.fallbackSpecs {
            var entryValues: [MiotPropKey: JSONValue] = [:]
            for v in entry.values {
                entryValues[MiotPropKey(did: entry.did, siid: v.siid, piid: v.piid)] = v.value
            }
            let entryRecords = [
                MiDeviceRecord(did: entry.did, name: entry.name, model: entry.model, isOnline: true, splitParentDid: nil, splitSiid: nil)
            ]
            let entryHome = MiotSynthesizer.synthesize(
                devices: entryRecords,
                rooms: [],
                specs: [entry.model: entry.spec],
                values: entryValues
            )
            let dev = try #require(entryHome.devices.first(where: { $0.id == entry.did }), "Missing fallback device \(entry.model)")
            #expect(dev.kind == entry.expectedKind.toDeviceKind(), "Fallback kind mismatch on \(entry.model)")
        }

        for record in records {
            let spec = try #require(corpus.specs[record.model])
            let expectedProps = try #require(corpus.expectedRequiredProps[record.did]).map {
                MiotPropKey(did: $0.did, siid: $0.siid, piid: $0.piid)
            }
            let actualProps = MiotSynthesizer.requiredProps(for: record, spec: spec)
            #expect(actualProps == expectedProps, "requiredProps mismatch on \(record.did)")
        }

        for item in corpus.commandCases {
            let spec = try #require(corpus.specs[item.model], "Missing spec \(item.model)")
            let cmd = try item.command.toDeviceCommand()
            let actualWrite = try MiotCommandMapper.map(cmd, spec: spec)
            #expect(actualWrite == item.expected.toMiotWrite(), "\(item.model) \(item.command.kind)")
        }
    }

    // MARK: - Issue #37: cloud region list shared with the Windows login screen

    @Test("Cross-platform region golden JSON corpus matches MiCloudRegion.allCases order (#37)")
    func regionGoldenCorpusParity() throws {
        let fixtureURL = try Self.locateGoldenFixture("Tests/Fixtures/region_golden.json")
        let corpus = try JSONDecoder().decode(RegionCorpus.self, from: Data(contentsOf: fixtureURL))

        // The array order is the login dropdown order, so it must match exactly, not just as a set:
        // Windows (windows/tests/core.test.ts) asserts MI_CLOUD_REGIONS against the same array.
        #expect(MiCloudRegion.allCases.map(\.rawValue) == corpus.regions)
        for code in corpus.regions {
            #expect(MiCloudRegion(rawValue: code) != nil, "shared corpus region \(code) is unknown to MiCloudRegion")
        }
        #expect(Set(corpus.regions).count == corpus.regions.count, "region corpus must not repeat a server")
    }

}
