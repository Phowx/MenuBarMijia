import Foundation

// MARK: - Undo Banner Hover Pause (#53)

/// Lets the panel hold the 撤销 banner open while the pointer rests on it.
///
/// Trade-off: resuming restarts the full banner duration instead of the exact remaining time. The
/// store's expiry task keeps no deadline, and a paused banner has no countdown UI, so re-arming the
/// whole window (10 s for one or two devices, 15 s from three) is the honest behaviour — the user
/// gets the full reading time after moving the pointer away (audit #53 allows "continue or reset").
extension HomeStore {
    /// Cancels the expiry task but keeps `undoBanner` on screen. Safe to call repeatedly.
    public func pauseUndoBannerCountdown() {
        guard undoBanner != nil else { return }
        undoTimerTask?.cancel()
        undoTimerTask = nil
    }

    /// Re-arms the expiry task for a paused banner. No-op when no banner is showing.
    public func resumeUndoBannerCountdown() {
        guard let banner = undoBanner else { return }
        undoTimerTask?.cancel()
        // `restoreCommands` holds one command per device for 全关 and at least one per device for
        // structured actions, so it never undercounts the action's reach. Automation banners carry
        // their own window (#59) and keep it here instead of dropping back to the device rule.
        let seconds = banner.duration ?? Self.undoBannerSeconds(forDeviceCount: max(1, banner.restoreCommands.count))
        undoTimerTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            if self?.undoBanner?.id == banner.id {
                self?.undoBanner = nil
            }
        }
    }
}
