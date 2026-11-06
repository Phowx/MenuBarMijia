import Foundation
import Testing
@testable import MijiaCore

/// Regression coverage for audit items #33–#36, #47, #50 and #53 (MijiaCore side).
struct AuditWave2Tests {
    static let studyCeiling = DeviceFixtures.studyCeiling
    static let studyDesk = DeviceFixtures.studyDesk

    static func light(
        id: String,
        name: String,
        roomId: String,
        roomName: String,
        isOn: Bool = false
    ) -> SmartDevice {
        SmartDevice(
            id: id,
            name: name,
            roomId: roomId,
            roomName: roomName,
            model: "yeelink.light.lamp4",
            isOnline: true,
            kind: .light(LightSpec(entityId: "light.\(id)", isOn: isOn))
        )
    }

    @MainActor
    private func waitForDevices(_ store: HomeStore, count: Int = 1) async throws {
        for _ in 0..<100 where store.devices.count < count {
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    @MainActor
    private func makeStore(
        devices: [SmartDevice],
        scenes: [HomeScene] = [],
        readings: [EnvironmentReading] = [],
        suite: String? = nil
    ) async throws -> (HomeStore, MockHomeProvider) {
        let snapshot = SynthesizedHome(devices: devices, environmentReadings: readings, scenes: scenes)
        let mock = MockHomeProvider(snapshot: snapshot)
        let store = HomeStore(
            provider: mock,
            defaultsSuiteName: suite ?? "test.auditwave2.\(UUID().uuidString)"
        )
        for _ in 0..<100 {
            if store.devices.count >= devices.count && (readings.isEmpty || !store.environmentReadings.isEmpty) {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        return (store, mock)
    }

    // MARK: - #33: every controllable device reaches the model

    @Test("A 5W plug never triggers the long-running reminder; a high-power plug does")
    @MainActor
    func longRunningPlugRequiresPower() async throws {
        let lowPowerPlug = SmartDevice(
            id: "plug_low",
            name: "路由器插座",
            roomId: "study",
            roomName: "书房",
            model: "cuco.plug.v3",
            isOnline: true,
            kind: .plug(PlugSpec(switchEntityId: "switch.low", isOn: true, powerWatts: 5))
        )
        let noDataPlug = SmartDevice(
            id: "plug_nodata",
            name: "冰箱插座",
            roomId: "kitchen",
            roomName: "厨房",
            model: "cuco.plug.v3",
            isOnline: true,
            kind: .plug(PlugSpec(switchEntityId: "switch.nodata", isOn: true))
        )
        let highPowerPlug = SmartDevice(
            id: "plug_high",
            name: "咖啡机插座",
            roomId: "kitchen",
            roomName: "厨房",
            model: "cuco.plug.v3",
            isOnline: true,
            kind: .plug(PlugSpec(switchEntityId: "switch.high", isOn: true, powerWatts: 1_200))
        )

        let (lowStore, _) = try await makeStore(devices: [lowPowerPlug])
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(lowStore.evaluateSafetyAlerts(now: start).isEmpty)
        #expect(lowStore.evaluateSafetyAlerts(now: start.addingTimeInterval(46 * 60)).isEmpty)

        let (noDataStore, _) = try await makeStore(devices: [noDataPlug])
        #expect(noDataStore.evaluateSafetyAlerts(now: start).isEmpty)
        #expect(noDataStore.evaluateSafetyAlerts(now: start.addingTimeInterval(46 * 60)).isEmpty)

        let (highStore, _) = try await makeStore(devices: [highPowerPlug])
        #expect(highStore.evaluateSafetyAlerts(now: start).isEmpty)
        let highAlerts = highStore.evaluateSafetyAlerts(now: start.addingTimeInterval(46 * 60))
        let hasHighPowerAlert = highAlerts.contains(where: { $0.id == "longrun:plug_high" })
        #expect(hasHighPowerAlert)
    }

    @Test("A low-battery alert does not repeat after relaunch within 24 hours")
    @MainActor
    func lowBatteryCooldownPersistsAcrossStores() async throws {
        let suite = "test.auditwave2.battery.\(UUID().uuidString)"
        let sensor = SmartDevice(
            id: "sensor_low",
            name: "门磁",
            roomId: "hall",
            roomName: "走廊",
            model: "lumi.sensor_magnet",
            isOnline: true,
            kind: .sensor(SensorSpec(battery: 10))
        )
        let now = Date(timeIntervalSince1970: 1_800_000_000)

        let (first, _) = try await makeStore(devices: [sensor], suite: suite)
        let firstAlerts = first.evaluateSafetyAlerts(now: now)
        let firstHasBatteryAlert = firstAlerts.contains(where: { $0.id == "battery:sensor_low" })
        #expect(firstHasBatteryAlert)

        let (second, _) = try await makeStore(devices: [sensor], suite: suite)
        #expect(second.evaluateSafetyAlerts(now: now.addingTimeInterval(3_600)).isEmpty)

        let thirdStore = try await makeStore(
            devices: [sensor],
            suite: "test.auditwave2.battery.\(UUID().uuidString)"
        )
        let third = thirdStore.0
        let thirdAlerts = third.evaluateSafetyAlerts(now: now)
        let thirdHasBatteryAlert = thirdAlerts.contains(where: { $0.id == "battery:sensor_low" })
        #expect(thirdHasBatteryAlert)

        let fourthStore = try await makeStore(devices: [sensor], suite: suite)
        let fourthAlerts = fourthStore.0.evaluateSafetyAlerts(now: now.addingTimeInterval(86_401))
        let fourthHasBatteryAlert = fourthAlerts.contains(where: { $0.id == "battery:sensor_low" })
        #expect(fourthHasBatteryAlert)
    }

    // MARK: - #36: room order and menu bar follow the provider, not hardcoded names

    @Test("English room names keep the provider room order for rooms, devices and readings")
    func englishRoomOrderFollowsProvider() {
        let devices = [
            Self.light(id: "bed", name: "Bed Lamp", roomId: "r-bed", roomName: "Bedroom"),
            Self.light(id: "living", name: "Ceiling", roomId: "r-living", roomName: "Living Room"),
            Self.light(id: "study", name: "Desk Lamp", roomId: "r-study", roomName: "Study")
        ]
        let readings = [
            EnvironmentReading(id: "s-bed", label: "Bedroom", roomName: "Bedroom", temperature: 24, humidity: 50),
            EnvironmentReading(id: "s-living", label: "Living Room", roomName: "Living Room", temperature: 25.5, humidity: 45),
            EnvironmentReading(id: "s-study", label: "Study", roomName: "Study", temperature: 26, humidity: 40)
        ]
        let order = DeviceSynthesizer.roomNameOrder(from: ["Living Room", "Bedroom", "Study"])
        let home = DeviceSynthesizer.assembleHome(
            devices: devices,
            readings: readings,
            scenes: [],
            roomNameOrder: order
        )

        #expect(home.rooms.map(\.name) == ["Living Room", "Bedroom", "Study"])
        #expect(home.devices.map(\.roomName) == ["Living Room", "Bedroom", "Study"])
        #expect(home.environmentReadings.map(\.roomName) == ["Living Room", "Bedroom", "Study"])
    }

    @Test("HA synthesis keeps the area registry order for English room names")
    func haSynthesisKeepsEnglishAreaOrder() {
        let areas = [
            HAAreaEntry(area_id: "a_living", name: "Living Room"),
            HAAreaEntry(area_id: "a_bed", name: "Bedroom")
        ]
        // Registry device order is deliberately the reverse of the area order.
        let devices = [
            HADeviceEntry(id: "d_bed", area_id: "a_bed", name: "Bed Lamp"),
            HADeviceEntry(id: "d_living", area_id: "a_living", name: "Ceiling")
        ]
        let entities = [
            HAEntityEntry(entity_id: "light.bed", device_id: "d_bed"),
            HAEntityEntry(entity_id: "light.living", device_id: "d_living")
        ]
        let states = [
            "light.bed": HAEntityState(entityId: "light.bed", state: "off"),
            "light.living": HAEntityState(entityId: "light.living", state: "off")
        ]

        let home = DeviceSynthesizer.synthesize(
            areas: areas,
            devices: devices,
            entities: entities,
            states: states
        )
        #expect(home.rooms.map(\.name) == ["Living Room", "Bedroom"])
        #expect(home.devices.map(\.roomName) == ["Living Room", "Bedroom"])
    }

    @Test("A legacy 主卧/阳台 menu-bar mode migrates to the first temperature sensor")
    @MainActor
    func legacyMenuBarModeMigrates() async throws {
        let suite = "test.auditwave2.menubar.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.set("primaryTemp", forKey: "menubar_display_mode")
        let living = EnvironmentReading(
            id: "sensor_living",
            label: "Living Room Sensor",
            roomName: "Living Room",
            temperature: 25.5,
            humidity: 45
        )
        let bedroom = EnvironmentReading(
            id: "sensor_bedroom",
            label: "Bedroom Sensor",
            roomName: "Bedroom",
            temperature: 24.2,
            humidity: 50
        )

        let (store, _) = try await makeStore(devices: [], readings: [living, bedroom], suite: suite)

        #expect(store.menuBarDisplayMode == .sensorTemperature)
        #expect(store.menuBarTargetId == "temp:sensor_living")
        L10n.$overrideTemperatureUnit.withValue(.celsius) {
            #expect(store.menuBarText == "25.5°C")
        }
        #expect(defaults.string(forKey: "menubar_display_mode") == MenuBarDisplayMode.sensorTemperature.rawValue)
    }

    @Test("Without a stored mode the menu bar defaults to the first temperature sensor")
    @MainActor
    func menuBarUsesFirstSensorByDefault() async throws {
        let suite = "test.auditwave2.menubar.default.\(UUID().uuidString)"
        let bedroom = EnvironmentReading(
            id: "sensor_bedroom",
            label: "Bedroom Sensor",
            roomName: "Bedroom",
            temperature: 24.2,
            humidity: 50
        )
        let (store, _) = try await makeStore(devices: [], readings: [bedroom], suite: suite)

        #expect(store.menuBarDisplayMode == .sensorTemperature)
        L10n.$overrideTemperatureUnit.withValue(.celsius) {
            #expect(store.menuBarText == "24.2°C")
        }
        let hasRoomNameOption = store.availableMenuBarOptions.contains(where: { $0.title.contains("主卧") })
        #expect(!hasRoomNameOption)
    }

    @Test("柔和夜灯 falls back to the last manually switched-on light in any language")
    @MainActor
    func softNightLightUsesLastManualLight() async throws {
        let suite = "test.auditwave2.nightlight.\(UUID().uuidString)"
        let bedroomLight = Self.light(id: "bed_light", name: "Bed Lamp", roomId: "bed", roomName: "Bedroom")
        let livingLight = Self.light(id: "living_light", name: "Ceiling", roomId: "living", roomName: "Living Room")
        let (store, _) = try await makeStore(devices: [bedroomLight, livingLight], suite: suite)

        let living = try #require(store.devices.first(where: { $0.id == "living_light" }))
        store.togglePrimary(living)                 // on
        store.togglePrimary(living)                 // off, but remembered
        try await Task.sleep(for: .milliseconds(30))

        store.executeQuickAction(.softNightLight)
        let bedroomAfter = try #require(store.devices.first(where: { $0.id == "bed_light" }))
        let livingAfter = try #require(store.devices.first(where: { $0.id == "living_light" }))
        #expect(bedroomAfter.isActiveOn == false)
        #expect(livingAfter.isActiveOn == true)

        // The choice survives a relaunch.
        let (reloaded, _) = try await makeStore(devices: [bedroomLight, livingLight], suite: suite)
        reloaded.executeQuickAction(.softNightLight)
        let reloadedBedroomOn = reloaded.devices.first(where: { $0.id == "bed_light" })?.isActiveOn
        let reloadedLivingOn = reloaded.devices.first(where: { $0.id == "living_light" })?.isActiveOn
        #expect(reloadedBedroomOn == false)
        #expect(reloadedLivingOn == true)
    }

    @Test("Without any manual history, 柔和夜灯 uses the first light")
    @MainActor
    func softNightLightFallsBackToFirstLight() async throws {
        let bedroomLight = Self.light(id: "bed_light", name: "Bed Lamp", roomId: "bed", roomName: "Bedroom")
        let livingLight = Self.light(id: "living_light", name: "Ceiling", roomId: "living", roomName: "Living Room")
        let (store, _) = try await makeStore(devices: [bedroomLight, livingLight])

        store.executeQuickAction(.softNightLight)
        #expect(store.devices.first(where: { $0.id == "bed_light" })?.isActiveOn == true)
        #expect(store.devices.first(where: { $0.id == "living_light" })?.isActiveOn == false)
    }

    // MARK: - #47: built-in demo backend

    @Test("Demo backend serves a virtual home and applies commands without an account")
    @MainActor
    func demoBackendServesVirtualHome() async throws {
        let suite = "test.auditwave2.demo.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.set(HomeBackend.demo.rawValue, forKey: "home_backend")

        let store = HomeStore(defaultsSuiteName: suite)
        try await waitForDevices(store, count: 10)

        #expect(store.homeBackend == .demo)
        let usesDemoProvider = store.provider is DemoHomeProvider
        #expect(usesDemoProvider)
        #expect(store.connectionStatus == .connected)
        #expect(Set(store.devices.map(\.roomName)).count == 3)
        let kinds = store.devices.map(\.kind)
        let hasLight = kinds.contains { if case .light = $0 { return true } else { return false } }
        let hasClimate = kinds.contains { if case .climate = $0 { return true } else { return false } }
        let hasPlug = kinds.contains { if case .plug = $0 { return true } else { return false } }
        let hasSensor = kinds.contains { if case .sensor = $0 { return true } else { return false } }
        let hasTV = kinds.contains { if case .tv = $0 { return true } else { return false } }
        #expect(hasLight)
        #expect(hasClimate)
        #expect(hasPlug)
        #expect(hasSensor)
        #expect(hasTV)
        #expect(store.environmentReadings.count == 3)

        let lamp = try #require(store.devices.first(where: { $0.id == "demo_study_light" }))
        store.togglePrimary(lamp)
        await store.provider.refreshNow()
        try await Task.sleep(for: .milliseconds(30))
        let demoLampOn = store.devices.first(where: { $0.id == "demo_study_light" })?.isActiveOn
        #expect(demoLampOn == true)
    }

    @Test("Switching to the demo backend replaces the live provider")
    @MainActor
    func switchToDemoBackend() async throws {
        let (store, _) = try await makeStore(devices: [Self.studyCeiling])
        store.switchBackend(.demo)
        #expect(store.homeBackend == .demo)
        let usesDemoProvider = store.provider is DemoHomeProvider
        #expect(usesDemoProvider)
        try await waitForDevices(store, count: 10)
        let hasDemoDevices = store.devices.contains(where: { $0.id.hasPrefix("demo_") })
        #expect(hasDemoDevices)
    }

    // MARK: - #50: privacy-first speech default

}
