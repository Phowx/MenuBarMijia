import AppKit
import CoreGraphics
import Foundation
import MijiaCore

/// Observes Mac state and runs the user's automation rules (#59).
///
/// Triggers are grouped so one lid close cannot fire a rule several times:
/// - `away`: `willSleep`, `screensDidSleep`, and the distributed lock notification.
/// - `back`: `didWake`, `screensDidWake`, and the distributed unlock notification.
/// - external display connect/disconnect: active non-built-in display count changes.
///
/// Reliability notes:
/// - `com.apple.screenIsLocked` / `com.apple.screenIsUnlocked` are distributed notifications, not
///   public NSWorkspace events. They do not arrive in a sandboxed process and can be missed while
///   the display is asleep; lock-based rules are therefore best-effort. This app is distributed
///   outside the sandbox, so it receives them today.
/// - Sleep rules may run just before the Mac suspends; a cloud command can be cut off mid-flight.
///   The optimistic update rolls back when dispatch fails, and the same rule fires again after
///   the next `back`/`away` transition at the earliest one minute later.
/// - `AutomationTriggerDeduper` coalesces bursts per trigger for one minute and persists the
///   timestamps, so relaunching the app does not replay a rule.
///
/// Demo mode uses `DemoHomeProvider`: commands are applied to an in-memory virtual home and never
/// touch the network (#47).
@MainActor
final class AutomationEngine {
    static let shared = AutomationEngine()

    private let ruleStore: AutomationRuleStore
    private let deduper: AutomationTriggerDeduper
    private weak var store: HomeStore?
    private var tokens: [any NSObjectProtocol] = []
    private var lastExternalDisplayCount: Int

    /// `defaults` is injectable for tests; the app always uses `.standard`.
    init(defaults: UserDefaults = .standard) {
        self.ruleStore = AutomationRuleStore(defaults: defaults)
        self.deduper = AutomationTriggerDeduper(defaults: defaults)
        self.lastExternalDisplayCount = Self.activeExternalDisplayCount()
    }

    func start(with store: HomeStore) {
        attach(store: store)
        guard tokens.isEmpty else { return }
        let workspace = NSWorkspace.shared.notificationCenter
        observe(workspace, NSWorkspace.willSleepNotification, .away)
        observe(workspace, NSWorkspace.screensDidSleepNotification, .away)
        observe(workspace, NSWorkspace.didWakeNotification, .back)
        observe(workspace, NSWorkspace.screensDidWakeNotification, .back)

        let distributed = DistributedNotificationCenter.default()
        observe(distributed, Notification.Name("com.apple.screenIsLocked"), .away)
        observe(distributed, Notification.Name("com.apple.screenIsUnlocked"), .back)

        // AppKit has no public “display connected” notification; enumerating active displays is the
        // documented substitute. Resolution-only changes keep the same count and are ignored.
        let screenToken = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.screenConfigurationChanged()
            }
        }
        tokens.append(screenToken)
    }

    /// Test seam: binds the store without subscribing to system notifications, so `handle(trigger:)`
    /// can be driven directly (Notifying systems cannot post in unit tests).
    func attach(store: HomeStore) {
        self.store = store
    }

    /// Test seam: notifying systems cannot post in unit tests, so the mapping is exercised by
    /// calling this directly. Observers above do exactly the same thing.
    func handle(trigger: AutomationTrigger, at now: Date = Date()) async {
        guard let store else { return }
        let rules = AutomationMatcher.rules(for: trigger, in: ruleStore.load())
        // An empty list must not burn the cooldown; the user may add a rule a moment later.
        guard !rules.isEmpty else { return }
        guard deduper.shouldFire(trigger, at: now) else { return }
        for rule in rules {
            await execute(rule, store: store)
        }
    }

    private func observe(
        _ center: NotificationCenter,
        _ name: Notification.Name,
        _ trigger: AutomationTrigger
    ) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                Task { @MainActor in
                    await self.handle(trigger: trigger)
                }
            }
        }
        tokens.append(token)
    }

    private func screenConfigurationChanged() {
        let count = Self.activeExternalDisplayCount()
        defer { lastExternalDisplayCount = count }
        guard count != lastExternalDisplayCount else { return }
        let trigger: AutomationTrigger = count > lastExternalDisplayCount
            ? .externalDisplayConnected
            : .externalDisplayDisconnected
        Task { @MainActor in
            await handle(trigger: trigger)
        }
    }

    /// Counts active displays that are not built into the Mac. Using total `NSScreen.screens.count`
    /// would report a disconnect when a laptop lid closes while an external display stays on.
    private static func activeExternalDisplayCount() -> Int {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return 0 }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        let maxDisplays = count
        guard CGGetActiveDisplayList(maxDisplays, &displays, &count) == .success else { return 0 }
        return displays.prefix(Int(count)).filter { CGDisplayIsBuiltin($0) == 0 }.count
    }

    private func execute(_ rule: AutomationRule, store: HomeStore) async {
        switch rule.action {
        // Quick actions aggregate devices in the store and already show their own toast plus undo
        // banner; the longer automation window keeps the banner usable after unlocking (#59).
        case .quickAction(let action):
            store.executeQuickAction(action, undoBannerDuration: AutomationPolicy.undoWindow)
        case .devices, .scene:
            let intents = rule.action.intents()
            guard !intents.isEmpty else { return }
            let summary = rule.action.summary(devices: store.devices, scenes: store.scenes)
            _ = await store.runAutomation(
                intents: intents,
                title: L10n.format("自动化：%@", "Automation: %@", summary)
            )

        }
    }
}
