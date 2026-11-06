import AppKit
import SwiftUI
import MijiaCore

/// App-owned status item and control panel. A left click toggles the panel; clicking
/// outside or deactivating the app dismisses it. The SwiftUI tree survives between opens.
@MainActor
final class MenuBarPanelController: NSObject, NSWindowDelegate {
    static let shared = MenuBarPanelController()

    static let panelWidth: CGFloat = PanelSizePreferences.defaultSize.width
    var preferences: UserDefaults = .standard
    var onQuit: @MainActor () -> Void = { NSApplication.shared.terminate(nil) }
    /// The panel draws its own material; AppKit only clips it to the extra's rounded corners.
    static let panelCornerRadius: CGFloat = 12

    /// Posted after the panel becomes visible, and after it is ordered out.
    static let didShowNotification = Notification.Name("MenuBarMijia.panelDidShow")
    static let didHideNotification = Notification.Name("MenuBarMijia.panelDidHide")

    private static let topGap: CGFloat = 6
    private static let screenMargin: CGFloat = 8
    private(set) var statusItem: NSStatusItem?
    private(set) var panelWindow: NSPanel?

    /// Tests switch this off so `swift test` shows the window without stealing key status or focus
    /// from the terminal; the app keeps it on, which is what makes the panel key like the extra was.
    var presentsActively = true

    private weak var store: HomeStore?
    private var labelTimer: Timer?
    /// What the status button currently shows; kept after a sync so diagnostics and tests can read it.
    private(set) var labelSymbol: String?
    private(set) var labelText: String?
    private(set) var tooltipText: String?
    private var observers: [any NSObjectProtocol] = []
    private var localMouseMonitor: Any?
    private var globalMouseMonitor: Any?
    private var didInstall = false

    override init() {
        super.init()
    }

    // MARK: - Installation

    /// Creates the status item and keeps its label in sync. Safe to call twice.
    ///
    /// The app calls this from `App.init`, possibly before the status bar is ready. If the resulting
    /// item never acquired a button window (which only happens when it was created too early), it is
    /// recreated once at `applicationDidFinishLaunching`.
    func install(with store: HomeStore) {
        self.store = store
        guard !didInstall else { return }
        didInstall = true
        createStatusItem()
        installMouseMonitors()
        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didFinishLaunchingNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.recoverStatusItemIfNeeded()
            }
        })
        installObservers()
        startLabelUpdates()
    }

    /// A status item created before the status bar was ready stays blank; remove and recreate it.
    func recoverStatusItemIfNeeded() {
        if let statusItem, statusItem.button?.window == nil {
            NSStatusBar.system.removeStatusItem(statusItem)
            self.statusItem = nil
            labelSymbol = nil
            labelText = nil
            tooltipText = nil
        }
        createStatusItem()
        syncStatusItem()
    }

    /// Releases the status item, the panel and every observer. Used by tests; the app keeps the item
    /// for its whole lifetime.
    func uninstall() {
        removeMouseMonitors()
        labelTimer?.invalidate()
        labelTimer = nil
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
        panelWindow?.delegate = nil
        panelWindow?.orderOut(nil)
        panelWindow?.contentView = nil
        panelWindow = nil
        if let statusItem {
            NSStatusBar.system.removeStatusItem(statusItem)
        }
        statusItem = nil
        store = nil
        didInstall = false
        labelSymbol = nil
        labelText = nil
        tooltipText = nil
    }

    private func createStatusItem() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.imagePosition = .imageLeading
            button.target = self
            button.action = #selector(handleStatusItemPress)
            // Toggle once on release; holding the icon has no secondary action.
            _ = button.sendAction(on: [.leftMouseUp])
        }
        statusItem = item
        syncStatusItem()
    }

    // MARK: - Menu Bar Label (#54)

    private func startLabelUpdates() {
        guard labelTimer == nil else { return }
        // Keep the menu-bar sensor label current; the label
        // lives in AppKit, so `@Observable` tracking cannot drive it.
        let timer = Timer(
            timeInterval: 0.5,
            target: self,
            selector: #selector(handleLabelTimerTick(_:)),
            userInfo: nil,
            repeats: true
        )
        labelTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    @objc private func handleLabelTimerTick(_ timer: Timer) {
        syncStatusItem()
    }

    /// Pushes icon, text, tooltip and accessibility label onto the status button.
    func syncStatusItem() {
        guard let button = statusItem?.button, let store else { return }
        let symbol = store.menuBarSymbolName
        let text = store.menuBarText
        let summary = MenuBarStatusSummary.text(for: store)

        if symbol != labelSymbol {
            labelSymbol = symbol
            if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) {
                image.isTemplate = true
                button.image = image
            }
        }
        if text != labelText {
            labelText = text
            button.attributedTitle = Self.statusTitle(text)
        }
        if summary != tooltipText {
            tooltipText = summary
            button.toolTip = summary
            button.setAccessibilityLabel(summary)
            button.setAccessibilityHelp(summary)
        }
    }

    private static func statusTitle(_ text: String?) -> NSAttributedString {
        guard let text, !text.isEmpty else { return NSAttributedString(string: "") }
        let size: CGFloat = 12
        let weight: NSFont.Weight = .medium
        var font: NSFont
        if text.contains(where: { $0.isNumber }) {
            font = .monospacedDigitSystemFont(ofSize: size, weight: weight)
        } else {
            let base = NSFont.systemFont(ofSize: size, weight: weight)
            let descriptor = base.fontDescriptor.withDesign(.rounded) ?? base.fontDescriptor
            font = NSFont(descriptor: descriptor, size: size) ?? base
        }
        return NSAttributedString(
            string: " " + text,
            attributes: [.font: font, .foregroundColor: NSColor.labelColor]
        )
    }

    // MARK: - Showing & Hiding

    var isPanelVisible: Bool {
        panelWindow?.isVisible == true
    }

    /// True for the control center panel or a window it owns (sheet, context menu, child), so both
    /// keyboard handling and the outside-click rule can tell it apart from Settings.
    func isPanelWindow(_ window: NSWindow?) -> Bool {
        guard let window, let panelWindow else { return false }
        if window === panelWindow { return true }
        if window.parent === panelWindow { return true }
        if panelWindow.attachedSheet === window { return true }
        return panelWindow.childWindows?.contains { $0 === window } ?? false
    }

    func togglePanel() {
        if isPanelVisible {
            hidePanel()
        } else {
            showPanel()
        }
    }

    func showPanel() {
        guard let store else { return }
        let panel = panelWindow ?? Self.makePanel(size: Self.preferredContentSize(screen: statusScreen, defaults: preferences))
        panelWindow = panel
        panel.delegate = self
        updateResizeLimits(for: panel)
        panel.appearance = Self.preferredAppearance()
        if panel.contentView == nil {
            attachContent(to: panel)
        }

        let target = Self.frame(for: Self.preferredContentSize(screen: statusScreen, defaults: preferences), anchor: statusAnchor, screen: statusScreen)
        if panel.frame != target {
            panel.setFrame(target, display: true)
        }

        let wasVisible = panel.isVisible
        installMouseMonitors()
        if presentsActively {
            // Order the window in first: cooperative activation only succeeds once the app has a
            // window to become active for, and this agent app owns none at that moment.
            panel.makeKeyAndOrderFront(nil)
            if !NSApp.isActive {
                NSApp.activate()
            }
        } else {
            panel.orderFront(nil)
        }
        // Re-showing an already visible panel (hotkey while open, URL scheme, intent) must not replay
        // the drop-in animation.
        guard !wasVisible else { return }
        store.setPanelVisible(true)
        NotificationCenter.default.post(name: Self.didShowNotification, object: panel)
    }

    func hidePanel() {
        guard let panel = panelWindow, panel.isVisible else { return }
        panel.orderOut(nil)
        store?.setPanelVisible(false)
        // The SwiftUI tree stays alive, exactly like a `.window`-style `MenuBarExtra`: scroll
        // position, the search field text and layout-editing state survive a close/reopen. The drop-in
        // animation is reset through `didShowNotification` in `ControlCenterPanel`.
        NotificationCenter.default.post(name: Self.didHideNotification, object: panel)
    }

    func updatePanelSize(width: CGFloat, height: CGFloat) {
        guard let panel = panelWindow else { return }
        let size = PanelSizePreferences.constrained(NSSize(width: width, height: height), available: availableSize)
        panel.setFrame(Self.frame(for: size, anchor: statusAnchor, screen: statusScreen), display: true)
    }

    private var availableSize: NSSize {
        let frame = (statusScreen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSSize(width: frame.width - 16, height: frame.height - 24)
    }

    private func updateResizeLimits(for panel: NSPanel) {
        panel.minSize = NSSize(width: min(PanelSizePreferences.minimumSize.width, availableSize.width),
                               height: min(PanelSizePreferences.minimumSize.height, availableSize.height))
        panel.maxSize = availableSize
    }

    func windowWillResize(_ sender: NSWindow, to frameSize: NSSize) -> NSSize {
        PanelSizePreferences.constrained(frameSize, available: availableSize)
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window === panelWindow else { return }
        rememberPanelSize()
    }

    func rememberPanelSize() {
        guard let panel = panelWindow else { return }
        PanelSizePreferences.save(panel.frame.size, to: preferences)
    }

    func resizePanel(from start: NSRect, delta: NSSize) {
        guard let panel = panelWindow else { return }
        let visible = (panel.screen ?? statusScreen ?? NSScreen.main)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        panel.setFrame(PanelSizePreferences.draggedFrame(from: start, delta: delta, visibleFrame: visible), display: true)
    }

    func resetPanelSize() {
        PanelSizePreferences.reset(in: preferences)
        updatePanelSize(width: PanelSizePreferences.defaultSize.width, height: PanelSizePreferences.defaultSize.height)
    }

    private static func makePanel(size: NSSize) -> NSPanel {
        let panel = MenuBarPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.animationBehavior = .none
        panel.isMovable = false
        panel.isMovableByWindowBackground = false
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.appearance = preferredAppearance()
        panel.contentView = nil
        return panel
    }

    /// Mirrors `AppAppearance` onto the AppKit panel so materials, dynamic `NSColor`s, menus and
    /// tooltips match the SwiftUI scheme.
    static func preferredAppearance() -> NSAppearance? {
        let raw = UserDefaults.standard.string(forKey: AppAppearance.storageKey)
        return (raw.flatMap(AppAppearance.init(rawValue:)) ?? .system).nsAppearance
    }

    private func attachContent(to panel: NSPanel) {
        guard let store else { return }
        let hosting = NSHostingView(rootView: ControlCenterPanel(store: store, onQuit: onQuit))
        hosting.frame = NSRect(origin: .zero, size: panel.frame.size)
        hosting.autoresizingMask = [.width, .height]
        hosting.sizingOptions = []
        hosting.wantsLayer = true
        hosting.layer?.cornerRadius = Self.panelCornerRadius
        hosting.layer?.masksToBounds = true
        panel.contentView = hosting
        panel.initialFirstResponder = hosting
        _ = panel.makeFirstResponder(hosting)
    }

    static func preferredContentSize(screen: NSScreen? = nil, defaults: UserDefaults = .standard) -> NSSize {
        let visible = (screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return PanelSizePreferences.load(from: defaults, available: NSSize(width: visible.width - 16, height: visible.height - 24))
    }

    // MARK: - Positioning

    private var statusAnchor: NSRect? {
        guard let button = statusItem?.button, let window = button.window else { return nil }
        return window.convertToScreen(button.convert(button.bounds, to: nil))
    }

    private var statusScreen: NSScreen? {
        statusItem?.button?.window?.screen ?? NSScreen.main
    }

    /// Puts the panel's top edge just under the status item, centred on it, clamped into the visible
    /// frame of whichever screen hosts the item (a menu bar on a secondary display included).
    private static func frame(for size: NSSize, anchor: NSRect?, screen: NSScreen?) -> NSRect {
        let visible = screen?.visibleFrame ?? NSScreen.main?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let width = min(size.width, visible.width - screenMargin * 2)
        let height = min(size.height, visible.height - screenMargin * 2)
        var x = (anchor?.midX ?? visible.midX) - width / 2
        x = min(max(x, visible.minX + screenMargin), visible.maxX - width - screenMargin)
        let top = anchor?.minY ?? visible.maxY
        let y = max(top - height - topGap, visible.minY + screenMargin)
        return NSRect(x: x.rounded(), y: y.rounded(), width: width, height: height)
    }

    // MARK: - Status Item Gesture

    /// A left click toggles once on release, with no secondary hold action.
    @objc func handleStatusItemPress() {
        togglePanel()
    }

    // MARK: - Outside Click, Screens & Preferences

    private func installObservers() {
        // Outside clicks end the session through two public signals: activating another app
        // (`didResignActive`) and another window of ours taking key status. A SwiftUI context menu
        // opens its own window while the panel stays up, so that case is explicitly exempt.
        observers.append(NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            let window = notification.object as? NSWindow
            MainActor.assumeIsolated {
                self?.handleOtherWindowBecameKey(window)
            }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handleApplicationResignActive()
            }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handleScreenParametersChanged()
            }
        })
        // Height or skin changed in Settings while the panel is open: apply it right away.
        observers.append(NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handlePreferencesChanged()
            }
        })
    }

    /// Another window of ours (Settings, an alert) took key status: the panel closes, like the extra
    /// did when the user moved to the Settings scene. The status item's own window and anything the
    /// panel spawned (sheet, popover, context menu) are exempt.
    func handleOtherWindowBecameKey(_ window: NSWindow?) {
        guard isPanelVisible, let window else { return }
        guard !isPanelWindow(window) else { return }
        guard window !== statusItem?.button?.window else { return }
        guard window !== CameraLivePanelController.shared.panelWindow else { return }
        hidePanel()
    }

    private func installMouseMonitors() {
        guard localMouseMonitor == nil else { return }
        let clicks: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        localMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: clicks) { [weak self] event in
            MainActor.assumeIsolated {
                let point = event.window?.convertPoint(toScreen: event.locationInWindow)
                    ?? event.locationInWindow
                self?.handleMouseDown(in: event.window, at: point)
            }
            return event
        }
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: clicks) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handleMouseDown(in: nil, at: NSEvent.mouseLocation)
            }
        }
    }

    private func removeMouseMonitors() {
        if let localMouseMonitor { NSEvent.removeMonitor(localMouseMonitor) }
        if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
        localMouseMonitor = nil
        globalMouseMonitor = nil
    }

    /// A click need not activate another app (desktop, nonactivating panels, other status items).
    /// Keep our own controls and status button working, and never swallow the original click.
    func handleMouseDown(in window: NSWindow?, at screenPoint: NSPoint) {
        if let button = statusItem?.button, let statusWindow = button.window {
            let rect = statusWindow.convertToScreen(button.convert(button.bounds, to: nil))
            if window === statusWindow || rect.insetBy(dx: -6, dy: -6).contains(screenPoint) { return }
        }
        guard isPanelVisible, let panel = panelWindow, !isPanelWindow(window) else { return }
        if let camera = CameraLivePanelController.shared.panelWindow,
           camera.isVisible, window === camera || camera.frame.contains(screenPoint) { return }
        if panel.frame.contains(screenPoint) { return }
        if let children = panel.childWindows,
           children.contains(where: { $0.isVisible && $0.frame.contains(screenPoint) }) { return }
        hidePanel()
    }

    func handleApplicationResignActive() {
        if isPanelVisible { hidePanel() }
    }

    func handleScreenParametersChanged() {
        guard let panel = panelWindow, panel.isVisible else { return }
        updateResizeLimits(for: panel)
        panel.setFrame(
            Self.frame(for: Self.preferredContentSize(screen: statusScreen, defaults: preferences), anchor: statusAnchor, screen: statusScreen),
            display: true
        )
    }

    func handlePreferencesChanged() {
        panelWindow?.appearance = Self.preferredAppearance()
    }
}

/// Borderless panels are not key windows by default; the control center needs key status for arrow
/// keys, Esc, ⌘, and its text fields, as the `MenuBarExtra` window had.
final class MenuBarPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
