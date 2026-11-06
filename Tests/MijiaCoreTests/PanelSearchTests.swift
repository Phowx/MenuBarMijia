import Foundation
import Testing
@testable import MijiaCore

/// #60: searching the panel filters on names, rooms, full pinyin and pinyin initials, and Return
/// either toggles the highlighted device or runs the text as an instruction.
///
/// Transliteration is injected so these tests describe the *matching* rules; the ICU-backed
/// transliterator is checked separately where the platform provides one.
struct PanelSearchTests {
    static let livingLight = SmartDevice(
        id: "light_living", name: "客厅吸顶灯", roomId: "living", roomName: "客厅",
        model: "yeelink.light.ceiling13", isOnline: true,
        kind: .light(LightSpec(entityId: "light.living", isOn: false))
    )
    static let studyLight = SmartDevice(
        id: "light_study", name: "书房灯", roomId: "study", roomName: "书房",
        model: "yeelink.light.lamp4", isOnline: true,
        kind: .light(LightSpec(entityId: "light.study", isOn: true))
    )
    static let studySensor = SmartDevice(
        id: "sensor_study", name: "书房温湿度计", roomId: "study", roomName: "书房",
        model: "miaomiaoce.sensor_ht.t6", isOnline: true,
        kind: .sensor(SensorSpec(temperature: 23.4, humidity: 51))
    )
    static let routerPlug = SmartDevice(
        id: "plug_router", name: "路由器插座", roomId: "study", roomName: "书房",
        model: "cuco.plug.v3", isOnline: false,
        kind: .plug(PlugSpec(switchEntityId: "switch.router", isOn: true))
    )

    static let devices = [livingLight, studyLight, studySensor, routerPlug]

    /// Stands in for ICU: the panel passes the real transliterator, tests pass this table so the
    /// matching rules are exercised on every platform.
    static func syllables(_ text: String) -> [String]? {
        let table: [Character: String] = [
            "客": "ke", "厅": "ting", "吸": "xi", "顶": "ding", "灯": "deng",
            "书": "shu", "房": "fang", "温": "wen", "湿": "shi", "度": "du", "计": "ji",
            "路": "lu", "由": "you", "器": "qi", "插": "cha", "座": "zuo"
        ]
        let syllables = text.compactMap { table[$0] }
        return syllables.isEmpty ? nil : syllables
    }

    private func entries(_ devices: [SmartDevice]? = nil) -> [DeviceSearchEntry] {
        PanelSearch.entries(devices: devices ?? Self.devices, syllables: Self.syllables)
    }

    // MARK: - Normalisation

    @Test("Queries fold case, diacritics and spacing")
    func normalizationFoldsCaseDiacriticsAndSpaces() {
        #expect(PanelSearch.normalize("Shū Fáng") == PanelSearch.normalize("shufang"))
        #expect(PanelSearch.normalize("书房 灯！") == "书房灯")
        #expect(PanelSearch.normalize("ＤＥＮＧ") == "deng")
        #expect(PanelSearch.normalize("  ") == "")
    }

    // MARK: - Matching

    @Test("Pinyin initials find the device: sfd → 书房灯")
    func pinyinInitialsFindStudyLight() {
        let matches = PanelSearch.matches("sfd", entries: entries())
        #expect(matches.first?.deviceId == Self.studyLight.id)
    }

    @Test("Full pinyin finds the device")
    func fullPinyinFindsStudyLight() {
        #expect(PanelSearch.matches("shufangdeng", entries: entries()).map(\.deviceId) == [Self.studyLight.id])
        #expect(PanelSearch.matches("shufang", entries: entries()).contains { $0.deviceId == Self.studyLight.id })
    }

    @Test("Chinese name and room fragments match, best match first")
    func chineseNameAndRoomMatch() {
        #expect(PanelSearch.matches("书房灯", entries: entries()).first?.deviceId == Self.studyLight.id)

        let roomMatches = PanelSearch.matches("书房", entries: entries()).map(\.deviceId)
        #expect(Set(roomMatches) == [Self.studyLight.id, Self.studySensor.id, Self.routerPlug.id])
        // A name that starts with the room outranks a device that only lives in it, and the
        // incoming order breaks the tie between the two 书房 devices.
        #expect(roomMatches.first == Self.studyLight.id)
        #expect(roomMatches.last == Self.routerPlug.id)
    }

    @Test("Room pinyin and initials match too")
    func roomPinyinMatches() {
        #expect(PanelSearch.matches("sf", entries: entries()).count == 3)
        #expect(PanelSearch.matches("shufang", entries: entries()).count == 3)
    }

    @Test("Local aliases are searchable, and the original name no longer is")
    func aliasesReplaceTheSearchableName() {
        let aliased = PanelSearch.entries(
            devices: [Self.studyLight],
            aliases: [Self.studyLight.id: "阅读灯"],
            syllables: Self.syllables
        )
        #expect(PanelSearch.matches("阅读灯", entries: aliased).count == 1)
        #expect(PanelSearch.matches("书房灯", entries: aliased).isEmpty)
        // The room is still searchable, so the alias does not hide the device from a room query.
        #expect(PanelSearch.matches("书房", entries: aliased).count == 1)
    }

    @Test("An empty query keeps the incoming order and matches everything")
    func emptyQueryKeepsOrder() {
        #expect(PanelSearch.matches("", entries: entries()).map(\.deviceId) == Self.devices.map(\.id))
        #expect(PanelSearch.matches("   ", entries: entries()).count == Self.devices.count)
    }

    @Test("Nonsense matches nothing")
    func nonsenseMatchesNothing() {
        #expect(PanelSearch.matches("zzzz", entries: entries()).isEmpty)
    }

    @Test("Unavailable transliteration simply drops pinyin matches")
    func missingTransliterationDropsPinyinMatches() {
        let entries = PanelSearch.entries(devices: Self.devices, syllables: { _ in nil })
        #expect(entries.allSatisfy { $0.pinyin.isEmpty && $0.initials.isEmpty })
        #expect(PanelSearch.matches("sfd", entries: entries).isEmpty)
        #expect(PanelSearch.matches("书房灯", entries: entries).count == 1)
    }

    // MARK: - Guards

    @Test("Hidden devices never match; offline devices only while they are shown")
    func hiddenAndOfflineGuards() {
        let shown = PanelSearch.candidates(
            in: Self.devices,
            hiddenIds: [Self.studySensor.id],
            hideOffline: false
        )
        #expect(shown.map(\.id) == [Self.livingLight.id, Self.studyLight.id, Self.routerPlug.id])

        let onlineOnly = PanelSearch.candidates(in: Self.devices, hiddenIds: [], hideOffline: true)
        #expect(!onlineOnly.contains { $0.id == Self.routerPlug.id })

        // `sf` matches both 书房 devices plus the study plug's room; the hidden sensor drops out.
        let matches = PanelSearch.matches("sf", entries: PanelSearch.entries(devices: shown, syllables: Self.syllables))
        #expect(matches.map(\.deviceId) == [Self.studyLight.id, Self.routerPlug.id])
        let everything = PanelSearch.matches("sf", entries: entries())
        #expect(everything.contains { $0.deviceId == Self.studySensor.id })
    }

    @Test("results() maps ranks back to devices and enforces the visibility guards")
    func resultsMapsRanksToDevices() {
        let found = PanelSearch.results("sfd", devices: Self.devices, syllables: Self.syllables)
        #expect(found.map(\.id) == [Self.studyLight.id])

        let hidden = PanelSearch.results(
            "sf",
            devices: Self.devices,
            hiddenIds: [Self.studySensor.id],
            hideOffline: true,
            syllables: Self.syllables
        )
        #expect(hidden.map(\.id) == [Self.studyLight.id])

        // An empty query keeps the panel's own order, so opening search does not reshuffle the list.
        let all = PanelSearch.results("", devices: Self.devices, syllables: Self.syllables)
        #expect(all.map(\.id) == Self.devices.map(\.id))
        #expect(PanelSearch.results("zzz", devices: Self.devices, syllables: Self.syllables).isEmpty)
    }

    @Test("Search spans rooms even when a room filter is active")
    func searchSpansRooms() {
        // The panel passes every visible device, not `filteredDevices`, so a room filter must not
        // narrow the search. This asserts the helper keeps a device from another room.
        let entries = PanelSearch.entries(devices: Self.devices, syllables: Self.syllables)
        #expect(PanelSearch.matches("sfd", entries: entries).first?.deviceId == Self.studyLight.id)
        #expect(PanelSearch.matches("kt", entries: entries).first?.deviceId == Self.livingLight.id)
    }

    // MARK: - Keyboard rules

    private func action(
        _ key: PanelSearchKey,
        query: String = "",
        isSearching: Bool = false,
        isFieldFocused: Bool = false,
        hasSelection: Bool = false,
        hasExplicitSelection: Bool = false,
    ) -> PanelSearchAction {
        PanelSearch.action(for: key, context: PanelSearchContext(
            query: query,
            isSearching: isSearching,
            isFieldFocused: isFieldFocused,
            hasSelection: hasSelection,
            hasExplicitSelection: hasExplicitSelection,
        ))
    }

    @Test("Typing with no search open starts one, but digits and Space stay shortcuts")
    func typingStartsSearchButShortcutsWin() {
        #expect(action(.init(kind: .character("s"))) == .appendQuery("s"))
        #expect(action(.init(kind: .character("书"))) == .appendQuery("书"))
        #expect(action(.init(kind: .character("1"))) == .ignore)
        #expect(action(.init(kind: .character(" "))) == .ignore)
        // Former language shortcuts now enter ordinary search.
        #expect(action(.init(kind: .character("/"))) == .appendQuery("/"))
        #expect(action(.init(kind: .character("v"))) == .appendQuery("v"))
        #expect(action(.init(kind: .character("V"))) == .appendQuery("V"))
        // Once a query exists, digits are part of it (e.g. `客厅灯2`).
        #expect(action(.init(kind: .character("2")), query: "客厅灯") == .appendQuery("2"))
        #expect(action(.init(kind: .character("v")), query: "tv") == .appendQuery("v"))
    }

    @Test("Focused field lets AppKit insert text, so IME and paste keep working")
    func focusedFieldDoesNotDoubleInsert() {
        #expect(action(.init(kind: .character("s")), isSearching: true, isFieldFocused: true) == .ignore)
        #expect(action(.init(kind: .delete), query: "sf", isSearching: true, isFieldFocused: true) == .ignore)
        #expect(action(.init(kind: .delete), query: "sf", isSearching: true) == .deleteBackward)
    }

    @Test("Esc clears the query first, and only then lets the panel close")
    func escapeClearsThenCloses() {
        #expect(action(.init(kind: .escape), query: "sfd", isSearching: true) == .clearQuery)
        #expect(action(.init(kind: .escape), isSearching: true) == .clearQuery)
        // Nothing to clear: the panel's existing Esc ladder (drawer, focus, close) takes over.
        #expect(action(.init(kind: .escape)) == .ignore)
    }

    @Test("Arrows move the selection only while searching")
    func arrowsMoveSelectionWhileSearching() {
        #expect(action(.init(kind: .down), query: "sf") == .moveSelection(1))
        #expect(action(.init(kind: .up), query: "sf") == .moveSelection(-1))
        // Without a query the panel's device focus navigation keeps the arrows.
        #expect(action(.init(kind: .down)) == .ignore)
        #expect(action(.init(kind: .up)) == .ignore)
    }

    @Test("Return only toggles a selected device; an unmatched sentence does nothing")
    func returnTogglesOrRuns() {
        #expect(action(.init(kind: .return), query: "sfd", hasSelection: true) == .toggleSelection)
        #expect(
            action(.init(kind: .return), query: "打开客厅灯", hasSelection: false) == .ignore
        )
        // An explicit selected search result can still be toggled.
        #expect(
            action(
                .init(kind: .return),
                query: "打开客厅灯",
                hasSelection: true,
                hasExplicitSelection: true
            ) == .toggleSelection
        )
        #expect(action(.init(kind: .return), query: "zzz", hasSelection: false) == .ignore)
        // No query: Return keeps the panel's existing "toggle focused device" behaviour.
        #expect(action(.init(kind: .return)) == .ignore)
    }

    @Test("Right arrow expands the highlighted device")
    func rightArrowExpands() {
        #expect(action(.init(kind: .right), query: "sfd", hasSelection: true) == .expandSelection)
        #expect(action(.init(kind: .right), query: "sfd", hasSelection: false) == .ignore)
        #expect(action(.init(kind: .right)) == .ignore)
    }

    @Test("Command and modifier chords stay with AppKit, except ⌘F")
    func modifierChordsStayWithAppKit() {
        #expect(action(.init(kind: .character("f"), hasCommand: true)) == .focusField)
        #expect(action(.init(kind: .character("v"), hasCommand: true)) == .ignore)
        #expect(action(.init(kind: .character("a"), hasCommand: true)) == .ignore)
        #expect(action(.init(kind: .character("a"), hasControl: true)) == .ignore)
        #expect(action(.init(kind: .character("e"), hasOption: true)) == .ignore)
        #expect(action(.init(kind: .escape, hasCommand: true), query: "sf") == .ignore)
        #expect(action(.init(kind: .tab), query: "sf") == .ignore)
    }

    @Test("⌘F focuses the field whether or not search is already open")
    func commandFFocusesField() {
        #expect(action(.init(kind: .character("f"), hasCommand: true)) == .focusField)
        #expect(action(.init(kind: .character("F"), hasCommand: true), query: "sf", isSearching: true) == .focusField)
    }
}
