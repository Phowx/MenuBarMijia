import AppKit
import SwiftUI
import Testing
import MijiaCore
@testable import MenuBarMijiaApp

/// #56: the control center is hosted by an app-owned `NSStatusItem` + `NSPanel` instead of the
/// `MenuBarExtra` scene. These tests drive the real AppKit objects — window creation, show/hide,
/// outside-click closing, sizing and positioning — with an in-memory home and no network.
///
/// `swift test` does not run the app, so the `Settings` scene, SwiftUI lifecycle and the menu bar
/// itself are out of reach; those remain manual acceptance on a Mac.
@MainActor
@Suite(.serialized)
struct MenuBarPanelControllerTests {
    private func makeStore() async throws -> (HomeStore, String) {
        let suite = "test.panel.controller.\(UUID().uuidString)"
        let mock = MockHomeProvider(snapshot: DemoHomeProvider.defaultHome())
        let store = HomeStore(provider: mock, defaultsSuiteName: suite)
        for _ in 0..<200 where store.devices.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(!store.devices.isEmpty, "MockHomeProvider should deliver a snapshot right away")
        return (store, suite)
    }

    private func makeController(store: HomeStore) -> MenuBarPanelController {
        // `swift test` does not launch an app; AppKit still needs its shared application object
        // before a status item or a window can exist.
        _ = NSApplication.shared
        let controller = MenuBarPanelController()
        controller.onQuit = { Issue.record("A panel interaction unexpectedly requested Quit") }
        controller.presentsActively = false
        controller.install(with: store)
        return controller
    }

    @Test("Installing creates one status item with a button and uninstall releases it")
    func installCreatesStatusItem() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        let item = try #require(controller.statusItem)
        #expect(item.button != nil)
        #expect(controller.panelWindow == nil, "the panel window is created lazily on first open")
        #expect(controller.isPanelVisible == false)

        controller.uninstall()
        #expect(controller.statusItem == nil)
        #expect(controller.panelWindow == nil)
    }

    @Test("Recreating the status item at launch finish keeps a single working item")
    func recoverStatusItemKeepsOneItem() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        controller.recoverStatusItemIfNeeded()
        controller.recoverStatusItemIfNeeded()

        let item = try #require(controller.statusItem)
        #expect(item.button != nil)
        #expect(controller.labelSymbol == store.menuBarSymbolName)
    }

    @Test("Status item button carries the summary as tooltip and accessibility label")
    func statusItemShowsSummary() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        let button = try #require(controller.statusItem?.button)
        controller.syncStatusItem()

        let summary = MenuBarStatusSummary.text(for: store)
        #expect(button.toolTip == summary)
        #expect(button.accessibilityLabel() == summary)
        let expectedTitle = try #require(store.menuBarText)
        #expect(button.attributedTitle.string.trimmingCharacters(in: .whitespaces) == expectedTitle)
    }

    @Test("Showing the panel creates a key-capable 376 pt window and marks it visible")
    func showPanelCreatesVisibleWindow() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        var didShow = false
        let token = NotificationCenter.default.addObserver(
            forName: MenuBarPanelController.didShowNotification,
            object: nil,
            queue: nil
        ) { _ in
            didShow = true
        }
        defer { NotificationCenter.default.removeObserver(token) }

        controller.showPanel()

        let panel = try #require(controller.panelWindow)
        #expect(controller.isPanelVisible)
        #expect(didShow)
        #expect(panel.isVisible)
        #expect(panel.canBecomeKey, "arrow keys and text fields need a key panel")
        #expect(panel.canBecomeMain == false)
        #expect(abs(panel.frame.width - MenuBarPanelController.preferredContentSize().width) < 1)
        #expect(panel.contentView is NSHostingView<ControlCenterPanel>)

        let expectedHeight = MenuBarPanelController.preferredContentSize().height
        #expect(abs(panel.frame.height - expectedHeight) < 1)
    }

    @Test("Hiding orders the window out, keeps the SwiftUI tree and posts the hide notification")
    func hidePanelKeepsContent() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        controller.showPanel()
        let panel = try #require(controller.panelWindow)
        let hosting = try #require(panel.contentView as? NSHostingView<ControlCenterPanel>)

        var didHide = false
        let token = NotificationCenter.default.addObserver(
            forName: MenuBarPanelController.didHideNotification,
            object: nil,
            queue: nil
        ) { _ in
            didHide = true
        }
        defer { NotificationCenter.default.removeObserver(token) }

        controller.hidePanel()

        #expect(didHide)
        #expect(controller.isPanelVisible == false)
        #expect(panel.isVisible == false)
        #expect(panel.contentView === hosting, "the SwiftUI tree survives a close")
        #expect(controller.panelWindow === panel, "the window is reused, not recreated")
    }

    @Test("Toggle switches between visible and hidden while preserving the same SwiftUI tree")
    func toggleCyclesVisibility() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        controller.togglePanel()
        let panel = try #require(controller.panelWindow)
        let hosting = try #require(panel.contentView as? NSHostingView<ControlCenterPanel>)
        #expect(controller.isPanelVisible)

        controller.togglePanel()
        #expect(controller.isPanelVisible == false)
        #expect(panel.contentView === hosting)

        controller.togglePanel()
        #expect(controller.isPanelVisible)
        #expect(panel.contentView === hosting)
    }

    @Test("The panel window is the only window recognised as the control center")
    func isPanelWindowMatchesOnlyThePanel() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        controller.showPanel()
        let panel = try #require(controller.panelWindow)
        let other = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 200, height: 200),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        defer { other.orderOut(nil) }

        let statusWindow = controller.statusItem?.button?.window
        #expect(controller.isPanelWindow(panel))
        #expect(controller.isPanelWindow(other) == false)
        #expect(controller.isPanelWindow(nil) == false)
        #expect(controller.isPanelWindow(statusWindow) == false, "the status item window is not the panel")
    }

    @Test("Panel resizes freely, saves dimensions and restores them after recreation")
    func panelSizingFollowsPreference() async throws {
        let (store, suite) = try await makeStore()
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("compact", forKey: PanelSizePreferences.legacyHeightKey)
        let controller = makeController(store: store)
        controller.preferences = defaults
        defer { controller.uninstall() }
        controller.showPanel()
        let panel = try #require(controller.panelWindow)
        #expect(panel.styleMask.contains(.resizable))
        let available = (panel.screen ?? NSScreen.main)?.visibleFrame.size ?? NSSize(width: 1440, height: 900)
        #expect(abs(panel.frame.height - min(460, available.height - 24)) < 1)
        controller.updatePanelSize(width: 490, height: 615)
        controller.windowDidEndLiveResize(Notification(name: NSWindow.didEndLiveResizeNotification, object: panel))
        let remembered = panel.frame.size
        #expect(abs(remembered.width - 490) < 1)
        #expect(defaults.double(forKey: PanelSizePreferences.widthKey) == Double(remembered.width))
        #expect(defaults.double(forKey: PanelSizePreferences.heightKey) == Double(remembered.height))
        #expect(panel.contentView?.frame.size == remembered)
        controller.hidePanel()
        controller.showPanel()
        #expect(panel.frame.size == remembered)
        controller.uninstall()
        controller.install(with: store)
        controller.showPanel()
        #expect(controller.panelWindow?.frame.size == remembered)
        controller.resetPanelSize()
        #expect(defaults.object(forKey: PanelSizePreferences.widthKey) == nil)
        #expect(defaults.object(forKey: PanelSizePreferences.legacyHeightKey) == nil)
        #expect(controller.panelWindow?.frame.width == PanelSizePreferences.defaultSize.width)
    }

    @Test("Resizing with the grip follows screen-space movement and persists on mouse-up")
    func gripResizePersists() async throws {
        let (store, suite) = try await makeStore()
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        controller.preferences = defaults
        defer { controller.uninstall() }
        controller.showPanel()
        let panel = try #require(controller.panelWindow)
        let grip = PanelResizeGrip(frame: NSRect(x: 0, y: 0, width: 18, height: 18))
        panel.contentView?.addSubview(grip)
        let start = panel.frame
        let pointer = NSPoint(x: start.maxX - 8, y: start.minY + 8)
        func event(_ type: NSEvent.EventType, point: NSPoint) throws -> NSEvent {
            try #require(NSEvent.mouseEvent(with: type, location: panel.convertPoint(fromScreen: point), modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber, context: nil,
                eventNumber: 0, clickCount: 1, pressure: 1))
        }
        let destination = NSPoint(x: pointer.x + 80, y: pointer.y - 35)
        let mouseDown = try event(.leftMouseDown, point: pointer)
        grip.mouseDown(with: mouseDown)
        grip.mouseDragged(with: try event(.leftMouseDragged, point: destination))
        grip.mouseUp(with: try event(.leftMouseUp, point: destination))
        #expect(panel.frame.width > start.width)
        #expect(defaults.double(forKey: PanelSizePreferences.widthKey) == Double(panel.frame.width))
        #expect(defaults.double(forKey: PanelSizePreferences.heightKey) == Double(panel.frame.height))
        #expect(panel.contentView?.frame.size == panel.frame.size)
        let persisted = panel.frame.size
        controller.handlePreferencesChanged()
        #expect(panel.frame.size == persisted)
    }

    @Test("Sizing while the panel is closed does not create a window")
    func sizingBeforeOpenIsIgnored() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        controller.updatePanelSize(width: MenuBarPanelController.panelWidth, height: 420)
        #expect(controller.panelWindow == nil)
    }

    @Test("The panel is placed under the menu bar of its screen and clamped on screen")
    func panelIsPositionedUnderTheMenuBar() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        controller.showPanel()
        let panel = try #require(controller.panelWindow)
        let visible = (panel.screen ?? NSScreen.main)?.visibleFrame

        if let visible {
            #expect(panel.frame.maxY <= visible.maxY + 1, "never above the visible frame")
            #expect(panel.frame.minY >= visible.minY - 1, "never below the screen")
            #expect(panel.frame.minX >= visible.minX - 1)
            #expect(panel.frame.maxX <= visible.maxX + 1)
        }
    }

    @Test("Another window taking key status closes the panel; the panel and its own children do not")
    func otherWindowBecameKeyClosesPanel() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        controller.showPanel()
        let panel = try #require(controller.panelWindow)

        controller.handleOtherWindowBecameKey(panel)
        #expect(controller.isPanelVisible, "the panel itself is not 'another window'")

        // A context menu or sheet the panel spawned keeps it open.
        let child = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 120, height: 120),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        defer { child.orderOut(nil) }
        panel.addChildWindow(child, ordered: .above)
        #expect(controller.isPanelWindow(child))
        controller.handleOtherWindowBecameKey(child)
        #expect(controller.isPanelVisible, "a panel-owned window must not dismiss the panel")

        let settingsLike = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 300),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        defer { settingsLike.orderOut(nil) }

        controller.handleOtherWindowBecameKey(settingsLike)
        #expect(controller.isPanelVisible == false)
    }

    @Test("An outside mouse click closes the panel without an application deactivation")
    func outsideMouseClickClosesPanel() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }
        controller.showPanel()
        let panel = try #require(controller.panelWindow)
        let outside = NSPoint(x: panel.frame.minX - 20, y: panel.frame.midY)
        controller.handleMouseDown(in: panel, at: panel.frame.origin)
        #expect(controller.isPanelVisible, "panel controls keep working")
        if let button = controller.statusItem?.button, let window = button.window {
            let frame = window.convertToScreen(button.convert(button.bounds, to: nil))
            controller.handleMouseDown(in: window, at: NSPoint(x: frame.midX, y: frame.midY))
            #expect(controller.isPanelVisible, "the status button must toggle on release")
        }
        let event = try #require(NSEvent.mouseEvent(
            with: .leftMouseDown, location: outside, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: 0,
            context: nil, eventNumber: 0, clickCount: 1, pressure: 1
        ))

        NSApp.sendEvent(event)

        #expect(!controller.isPanelVisible)
        #expect(!store.pollingContext.panelVisible)

        controller.showPanel()
        NSApp.sendEvent(event)
        #expect(!controller.isPanelVisible, "outside clicks still work after reopening")
    }

    @Test("Losing key status to another app closes the panel")
    func appDeactivationClosesPanel() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        controller.showPanel()
        #expect(controller.isPanelVisible)

        controller.handleApplicationResignActive()
        #expect(controller.isPanelVisible == false)
    }

    @Test("Showing the panel reports panel visibility to the store so polling can follow it")
    func showAndHideUpdatePollingContext() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        controller.showPanel()
        #expect(store.pollingContext.panelVisible)
        controller.hidePanel()
        #expect(store.pollingContext.panelVisible == false)
    }

    @Test("Keyboard shortcuts only take over inside the panel window")
    func keyboardHandlingIsPanelScoped() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let controller = makeController(store: store)
        defer { controller.uninstall() }

        controller.showPanel()
        let panel = try #require(controller.panelWindow)
        #expect(panel.canBecomeKey)
        #expect(controller.isPanelWindow(panel))
        // Settings is a different window, so ⌘,-style AppKit handling stays untouched there.
        #expect(controller.isPanelWindow(NSApp.keyWindow) == (NSApp.keyWindow === panel))
    }

    @Test("Dark appearance renders a dark panel background instead of light material")
    func classicDarkModeRendersDarkBackground() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }

        let prevAppearance = UserDefaults.standard.string(forKey: AppAppearance.storageKey)
        defer {
            if let prevAppearance { UserDefaults.standard.set(prevAppearance, forKey: AppAppearance.storageKey) }
            else { UserDefaults.standard.removeObject(forKey: AppAppearance.storageKey) }
        }

        UserDefaults.standard.set(AppAppearance.dark.rawValue, forKey: AppAppearance.storageKey)

        let controller = makeController(store: store)
        defer { controller.uninstall() }
        controller.showPanel()

        let panel = try #require(controller.panelWindow)
        let hosting = try #require(panel.contentView)
        panel.layoutIfNeeded()
        hosting.layoutSubtreeIfNeeded()
        hosting.displayIfNeeded()
        panel.displayIfNeeded()

        let size = hosting.bounds.size
        let bitmap = try #require(NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(size.width),
            pixelsHigh: Int(size.height),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ))
        bitmap.size = size
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)

        // Sample background pixel in the outer top-left padding (x: 10, y: 6) where no header views render.
        let bgColor = try #require(bitmap.colorAt(x: 10, y: 6)?.usingColorSpace(.deviceRGB))
        let luminance = 0.2126 * bgColor.redComponent + 0.7152 * bgColor.greenComponent + 0.0722 * bgColor.blueComponent
        let effectiveName = panel.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])
        #expect(effectiveName == .darkAqua)
        #expect(luminance < 0.35, "Classic dark mode panel background should be dark, got luminance \(luminance)")

        // Switching to forced light updates the panel's appearance right away.
        UserDefaults.standard.set(AppAppearance.light.rawValue, forKey: AppAppearance.storageKey)
        controller.handlePreferencesChanged()
        #expect(panel.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .aqua)
    }

    @Test("Holding the global shortcut only toggles once on release; key repeat has no secondary action")
    func globalHotkeyOnlyTogglesPanel() async throws {
        let (store, suite) = try await makeStore()
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        _ = NSApplication.shared
        let controller = MenuBarPanelController.shared
        let previousPresentsActively = controller.presentsActively
        controller.presentsActively = false
        controller.install(with: store)
        let manager = HotkeyAndNotificationManager.shared
        manager.attachStoreForTesting(store)
        defer {
            manager.attachStoreForTesting(nil)
            controller.uninstall()
            controller.presentsActively = previousPresentsActively
        }
        manager.handleGlobalHotKeyPressed()
        manager.handleGlobalHotKeyPressed()
        try await Task.sleep(for: .milliseconds(550))
        #expect(!controller.isPanelVisible)
        manager.handleGlobalHotKeyReleased()
        #expect(controller.isPanelVisible)
        manager.handleGlobalHotKeyReleased()
        #expect(controller.isPanelVisible)
        manager.handleGlobalHotKeyPressed()
        manager.handleGlobalHotKeyReleased()
        #expect(!controller.isPanelVisible)
        store.enableGlobalHotkey = false
        manager.handleGlobalHotKeyPressed()
        manager.handleGlobalHotKeyReleased()
        #expect(!controller.isPanelVisible)
    }

    @Test("Horizontal wheel monitor translates vertical mouse wheel and trackpad deltas into clamped horizontal scroll")
    func horizontalWheelMonitorScrollsAndClamps() {
        let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 240, height: 32))
        let documentView = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 32))
        scrollView.documentView = documentView

        // Rolling the mouse wheel down (negative deltaY) moves the horizontal strip right.
        let movedRight = HorizontalWheelScrollMonitor.applyHorizontalScroll(
            to: scrollView,
            deltaX: 0,
            deltaY: -2,
            hasPreciseDeltas: false
        )
        #expect(movedRight)
        #expect(scrollView.contentView.bounds.origin.x == 32)

        // Trackpad horizontal swipe right-to-left (negative deltaX) advances by exact points.
        let movedPrecise = HorizontalWheelScrollMonitor.applyHorizontalScroll(
            to: scrollView,
            deltaX: -48,
            deltaY: -4,
            hasPreciseDeltas: true
        )
        #expect(movedPrecise)
        #expect(scrollView.contentView.bounds.origin.x == 80)

        // Clamps at maxOffsetX (640 - 240 = 400) and back at 0.
        _ = HorizontalWheelScrollMonitor.applyHorizontalScroll(
            to: scrollView,
            deltaX: 0,
            deltaY: -1000,
            hasPreciseDeltas: true
        )
        #expect(scrollView.contentView.bounds.origin.x == 400)

        _ = HorizontalWheelScrollMonitor.applyHorizontalScroll(
            to: scrollView,
            deltaX: 0,
            deltaY: 1000,
            hasPreciseDeltas: true
        )
        #expect(scrollView.contentView.bounds.origin.x == 0)

        // Non-overflowing strip does not scroll.
        documentView.frame = NSRect(x: 0, y: 0, width: 200, height: 32)
        let movedWhenFitting = HorizontalWheelScrollMonitor.applyHorizontalScroll(
            to: scrollView,
            deltaX: 0,
            deltaY: -3,
            hasPreciseDeltas: false
        )
        #expect(!movedWhenFitting)
    }

    @Test("Room strip scrolls hidden rooms into view when selected or cycled")
    func classicSkinRoomStripScrollsToSelectedRoom() async throws {
        let rooms = [
            RoomArea(id: "r1", name: "书房", sortOrder: 0),
            RoomArea(id: "r2", name: "办公室", sortOrder: 1),
            RoomArea(id: "r3", name: "卧室", sortOrder: 2),
            RoomArea(id: "r4", name: "厨房", sortOrder: 3),
            RoomArea(id: "r5", name: "客厅", sortOrder: 4),
            RoomArea(id: "r6", name: "阳台", sortOrder: 5),
            RoomArea(id: "r7", name: "次卧", sortOrder: 6),
            RoomArea(id: "r8", name: "卫生间", sortOrder: 7)
        ]
        var base = DemoHomeProvider.defaultHome()
        base.rooms = rooms
        base.environmentReadings = []
        base.scenes = []

        let suite = "MenuBarPanelTests-rooms-\(UUID().uuidString)"
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        guard let defaults = UserDefaults(suiteName: suite) else { return }
        defaults.set(true, forKey: "has_completed_onboarding")
        defaults.set(false, forKey: "automatically_checks_for_updates")

        let store = HomeStore(provider: MockHomeProvider(snapshot: base), defaultsSuiteName: suite)
        for _ in 0..<50 where store.rooms.count < rooms.count {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(store.rooms.count == rooms.count)

        let hosting = NSHostingView(
            rootView: ControlCenterPanel(store: store)
                .defaultAppStorage(defaults)
                .environment(\.reduceMotionOverride, true)
        )
        hosting.frame = NSRect(x: 0, y: 0, width: 376, height: 560)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 376, height: 560),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.orderFront(nil)
        defer {
            window.contentView = nil
            window.orderOut(nil)
        }
        window.layoutIfNeeded()
        hosting.layoutSubtreeIfNeeded()
        hosting.displayIfNeeded()
        window.displayIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        Self.pumpMainRunLoop()

        func findRoomScrollView(in view: NSView) -> NSScrollView? {
            if let sv = view as? NSScrollView,
               let doc = sv.documentView,
               doc.bounds.width > sv.contentView.bounds.width + 20,
               sv.frame.height < 60 {
                return sv
            }
            for sub in view.subviews {
                if let found = findRoomScrollView(in: sub) {
                    return found
                }
            }
            return nil
        }

        let roomScrollView = try #require(findRoomScrollView(in: hosting))
        #expect(roomScrollView.contentView.bounds.origin.x < 1)

        store.selectedRoomId = "r8"
        try await Task.sleep(for: .milliseconds(80))
        Self.pumpMainRunLoop()
        hosting.layoutSubtreeIfNeeded()
        hosting.displayIfNeeded()
        window.displayIfNeeded()
        #expect(roomScrollView.contentView.bounds.origin.x > 40)

        store.selectedRoomId = nil
        try await Task.sleep(for: .milliseconds(80))
        Self.pumpMainRunLoop()
        hosting.layoutSubtreeIfNeeded()
        hosting.displayIfNeeded()
        window.displayIfNeeded()
        #expect(roomScrollView.contentView.bounds.origin.x < 1)
    }

    @Test("CameraLivePanelController attaches NSHostingView contentView and elevates above MenuBarPanel")
    func cameraLivePanelAttachesHostingViewAndOrdersAboveMenuBarPanel() async throws {
        let suite = "MenuBarPanelTests-camera-\(UUID().uuidString)"
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let store = HomeStore(provider: MockHomeProvider(snapshot: DemoHomeProvider.defaultHome()), defaultsSuiteName: suite)
        for _ in 0..<50 where store.devices.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        let camera = try #require(store.devices.first(where: {
            if case .camera = $0.kind { return true }
            return false
        }))

        let cameraController = CameraLivePanelController.shared
        cameraController.presentsActively = false
        cameraController.install(with: store)
        defer { cameraController.closePanel() }

        store.openCameraLiveView(camera.id)
        let panel = try #require(cameraController.panelWindow)
        #expect(panel.isVisible)
        #expect(panel.contentView is NSHostingView<CameraLivePanelView>, "NSPanel initializes with a blank NSView; present(device:) must replace it with NSHostingView<CameraLivePanelView>")
        #expect(panel.level.rawValue > NSWindow.Level.statusBar.rawValue)
    }

    @Test("TileResizeGestureMath maps 30pt horizontal and vertical translations across half, full, and panel (#115)")
    func tileResizeGestureMathThresholds() {
        #expect(TileResizeGestureMath.targetSize(startSize: .half, translation: CGSize(width: 30, height: 30), isCompactGrid: true) == .half)
        #expect(TileResizeGestureMath.targetSize(startSize: .full, translation: CGSize(width: -30, height: -30), isCompactGrid: true) == .full)

        #expect(TileResizeGestureMath.targetSize(startSize: .half, translation: CGSize(width: 31, height: 0), isCompactGrid: true) == .full)
        #expect(TileResizeGestureMath.targetSize(startSize: .half, translation: CGSize(width: 0, height: 31), isCompactGrid: true) == .full)
        #expect(TileResizeGestureMath.targetSize(startSize: .half, translation: CGSize(width: 60, height: 60), isCompactGrid: true) == .panel)
        #expect(TileResizeGestureMath.targetSize(startSize: .half, translation: CGSize(width: 65, height: 0), isCompactGrid: true) == .panel)
        #expect(TileResizeGestureMath.targetSize(startSize: .half, translation: CGSize(width: 0, height: 65), isCompactGrid: true) == .panel)

        #expect(TileResizeGestureMath.targetSize(startSize: .panel, translation: CGSize(width: -31, height: 0), isCompactGrid: true) == .full)
        #expect(TileResizeGestureMath.targetSize(startSize: .panel, translation: CGSize(width: 0, height: -31), isCompactGrid: true) == .full)
        #expect(TileResizeGestureMath.targetSize(startSize: .panel, translation: CGSize(width: -60, height: -60), isCompactGrid: true) == .half)
        #expect(TileResizeGestureMath.targetSize(startSize: .panel, translation: CGSize(width: -65, height: 0), isCompactGrid: true) == .half)
        #expect(TileResizeGestureMath.targetSize(startSize: .panel, translation: CGSize(width: 0, height: -65), isCompactGrid: true) == .half)

        #expect(TileResizeGestureMath.targetSize(startSize: .auto, translation: CGSize(width: 50, height: 0), isCompactGrid: true) == .full)
        #expect(TileResizeGestureMath.targetSize(startSize: .auto, translation: CGSize(width: 50, height: 0), isCompactGrid: false) == .panel)
        #expect(TileResizeGestureMath.targetSize(startSize: .auto, translation: CGSize(width: -50, height: 0), isCompactGrid: false) == .half)
    }

    @Test("TileResizeGestureMath computes release velocity from the last 100ms and projects a flick onto at most one step (#115)")
    func tileResizeGestureMathFlickProjection() {
        let now: TimeInterval = 100
        let fast = [
            TileResizeGestureMath.ResizeSample(offset: .zero, time: now - 0.08),
            TileResizeGestureMath.ResizeSample(offset: CGSize(width: 24, height: 16), time: now),
        ]
        let velocity = TileResizeGestureMath.releaseVelocity(fast, now: now)
        #expect(abs(velocity.width - 300) < 1)
        #expect(abs(velocity.height - 200) < 1)

        // A rested pointer yields no velocity, so a stationary release cannot fling.
        let rested = [
            TileResizeGestureMath.ResizeSample(offset: CGSize(width: 20, height: 10), time: now - 0.5),
            TileResizeGestureMath.ResizeSample(offset: CGSize(width: 20, height: 10), time: now - 0.4),
        ]
        #expect(TileResizeGestureMath.releaseVelocity(rested, now: now) == .zero)

        // Projection clamps to the threshold per axis: a 300pt/s flick adds ~one step.
        let projection = TileResizeGestureMath.projectedOffset(velocity: velocity)
        #expect(abs(projection.width - 29.7) < 0.001)
        #expect(abs(projection.height - 19.8) < 0.001)

        // A short sub-threshold drag plus its flick crosses the step at release.
        let shortDrag = TileResizeGestureMath.targetSize(
            startSize: .half,
            translation: CGSize(width: 20 + projection.width, height: 0),
            isCompactGrid: true
        )
        #expect(shortDrag == .full)

        // A slow drag projects nothing extra.
        let slow = TileResizeGestureMath.projectedOffset(velocity: CGSize(width: 100, height: -100))
        #expect(abs(slow.width - 9.9) < 0.001)
        #expect(abs(slow.height + 9.9) < 0.001)
    }

    @Test("Long-pressing a light card enters edit mode and bottom-right corner arc handle supports both drag resizing and tap cycling without reordering (#115)")
    func longPressOnLightCardEntersEditModeWithoutExpandingAndCyclesTileSizes() async throws {
        _ = NSApplication.shared
        let previousLanguage = L10n.currentLanguage
        L10n.currentLanguage = .zhHans
        let previousAppearance = UserDefaults.standard.string(forKey: AppAppearance.storageKey)
        UserDefaults.standard.set(AppAppearance.system.rawValue, forKey: AppAppearance.storageKey)

        let suite = "MenuBarPanelTests-resize-\(UUID().uuidString)"
        defer {
            UserDefaults.standard.removePersistentDomain(forName: suite)
            L10n.currentLanguage = previousLanguage
            if let previousAppearance {
                UserDefaults.standard.set(previousAppearance, forKey: AppAppearance.storageKey)
            }
        }
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.set(true, forKey: "has_completed_onboarding")
        defaults.set(AppLanguagePreference.zhHans.rawValue, forKey: "app_language")
        defaults.set(TemperatureUnitPreference.celsius.rawValue, forKey: TemperatureUnitPreference.storageKey)
        defaults.set(false, forKey: "automatically_checks_for_updates")
        defaults.set(true, forKey: "compact_grid_mode")

        let store = HomeStore(
            provider: MockHomeProvider(snapshot: DemoHomeProvider.defaultHome(includeCamera: false)),
            defaultsSuiteName: suite
        )
        for _ in 0..<200 where store.devices.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        let light = try #require(store.devices.first { dev in
            if case .light = dev.kind { return true }
            return false
        })
        let initialIsOn = light.isActiveOn

        let hosting = NSHostingView(
            rootView: ControlCenterPanel(store: store)
                .defaultAppStorage(defaults)
                .environment(\.reduceMotionOverride, true)
        )
        hosting.frame = NSRect(x: 0, y: 0, width: 376, height: 560)
        let window = NSWindow(
            contentRect: NSRect(x: 60, y: 120, width: 376, height: 560),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        defer {
            window.contentView = nil
            window.orderOut(nil)
        }
        window.layoutIfNeeded()
        hosting.layoutSubtreeIfNeeded()
        hosting.displayIfNeeded()
        window.displayIfNeeded()
        try await Task.sleep(for: .milliseconds(250))
        Self.pumpMainRunLoop()

        func sendMouse(_ type: NSEvent.EventType, at point: NSPoint) {
            guard let event = NSEvent.mouseEvent(
                with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 0, clickCount: 1, pressure: 1
            ) else { return }
            NSApp.sendEvent(event)
        }

        // Long-press on the right-side detail/expand area of the compact light card (x: 115, y: 395).
        let longPressPoint = NSPoint(x: 115, y: 395)
        sendMouse(.leftMouseDown, at: longPressPoint)
        try await Task.sleep(for: .milliseconds(550))
        Self.pumpMainRunLoop()
        sendMouse(.leftMouseUp, at: longPressPoint)
        try await Task.sleep(for: .milliseconds(150))
        Self.pumpMainRunLoop()

        #expect(store.expandedDeviceId == nil, "Releasing long-press must not trigger the card's expand-drawer button")
        #expect(store.devices.first(where: { $0.id == light.id })?.isActiveOn == initialIsOn)

        func handlePoint() -> NSPoint {
            if let g = LayoutUIState.shared.cardGlobalFrames[light.id] {
                return NSPoint(x: g.maxX - 6, y: hosting.bounds.height - g.maxY + 6)
            }
            return NSPoint(x: 176, y: 358)
        }
        func currentSizes() -> [String: TileSize] {
            DeviceLayoutPrefs.decode(defaults.string(forKey: DeviceLayoutPrefs.storageKey) ?? "{}")
        }
        func flushLayout() async throws {
            try await Task.sleep(for: .milliseconds(160))
            Self.pumpMainRunLoop()
            hosting.layoutSubtreeIfNeeded()
            hosting.displayIfNeeded()
            window.displayIfNeeded()
            Self.pumpMainRunLoop()
        }

        // 1. Outward drag on bottom-right corner arc handle: half -> full -> panel without reordering.
        let dragOutStart = handlePoint()
        sendMouse(.leftMouseDown, at: dragOutStart)
        try await Task.sleep(for: .milliseconds(30))
        Self.pumpMainRunLoop()

        let dragOutStep1 = NSPoint(x: dragOutStart.x + 60, y: dragOutStart.y)
        sendMouse(.leftMouseDragged, at: dragOutStep1)
        try await flushLayout()
        #expect(currentSizes()["all|\(light.id)"] == .full, "Dragging handle right > 45pt must step half -> full")

        let dragOutStep2 = NSPoint(x: dragOutStart.x + 60, y: dragOutStart.y - 60)
        sendMouse(.leftMouseDragged, at: dragOutStep2)
        try await flushLayout()
        #expect(currentSizes()["all|\(light.id)"] == .panel, "Continuing drag down > 45pt must step full -> panel")

        sendMouse(.leftMouseUp, at: dragOutStep2)
        try await flushLayout()
        #expect(currentSizes()["all|\(light.id)"] == .panel)
        #expect(DeviceLayoutPrefs.decodeOrder(defaults.string(forKey: DeviceLayoutPrefs.orderKey) ?? "[]").isEmpty, "Handle drag must not trigger card reordering")

        // 2. Inward drag on bottom-right corner arc handle: panel -> full -> half without reordering.
        let dragInStart = handlePoint()
        sendMouse(.leftMouseDown, at: dragInStart)
        try await Task.sleep(for: .milliseconds(30))
        Self.pumpMainRunLoop()

        let dragInStep1 = NSPoint(x: dragInStart.x - 60, y: dragInStart.y)
        sendMouse(.leftMouseDragged, at: dragInStep1)
        try await flushLayout()
        #expect(currentSizes()["all|\(light.id)"] == .full, "Dragging handle left < -45pt must step panel -> full")

        let dragInStep2 = NSPoint(x: dragInStart.x - 60, y: dragInStart.y + 60)
        sendMouse(.leftMouseDragged, at: dragInStep2)
        try await flushLayout()
        #expect(currentSizes()["all|\(light.id)"] == .half, "Continuing drag up < -45pt must step full -> half")

        sendMouse(.leftMouseUp, at: dragInStep2)
        try await flushLayout()
        #expect(currentSizes()["all|\(light.id)"] == .half)
        #expect(DeviceLayoutPrefs.decodeOrder(defaults.string(forKey: DeviceLayoutPrefs.orderKey) ?? "[]").isEmpty, "Inward handle drag must not trigger card reordering")

        // 3. Light tap on bottom-right corner arc handle still cycles half -> full -> panel -> half.
        func tapHandle() async throws -> [String: TileSize] {
            let point = handlePoint()
            sendMouse(.leftMouseDown, at: point)
            try await Task.sleep(for: .milliseconds(40))
            Self.pumpMainRunLoop()
            sendMouse(.leftMouseUp, at: point)
            try await flushLayout()
            return currentSizes()
        }

        let sizes1 = try await tapHandle()
        #expect(sizes1["all|\(light.id)"] == .full)

        let sizes2 = try await tapHandle()
        #expect(sizes2["all|\(light.id)"] == .panel)

        let sizes3 = try await tapHandle()
        #expect(sizes3["all|\(light.id)"] == .half)
    }

    private static func pumpMainRunLoop(_ seconds: TimeInterval = 0.05) {
        CFRunLoopRunInMode(.defaultMode, seconds, false)
    }
}
