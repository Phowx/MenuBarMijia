import Foundation

// MARK: - Automation Entry Point (#59)

extension HomeStore {
    /// Devices an external entry point may toggle: visible, online, and able to react to a single
    /// primary click. Used by App Intents (#57) so Shortcuts/Siri only offer actions that work.
    public var controllableDevices: [SmartDevice] {
        devices.filter { $0.isPrimaryToggleable && $0.isOnline && !hiddenDeviceIds.contains($0.id) }
    }

    /// Runs one automation rule through the same optimistic-update, dispatch, rollback, and undo
    /// path as the panel and external actions.
    ///
    /// Keeps the undo
    /// banner up for `AutomationPolicy.undoWindow`, because a lock/sleep rule usually fires while
    /// the panel is closed. Demo mode uses `DemoHomeProvider`, which applies commands to an
    /// in-memory home only — nothing is sent over the network (#47).
    @discardableResult
    public func runAutomation(intents: [DeviceIntent], title: String) async -> IntentPlan {
        let plan = IntentPlan(intents: intents, reply: title)
        guard !intents.isEmpty else { return plan }
        return await executeIntentPlan(plan, undoDuration: AutomationPolicy.undoWindow)
    }
}
