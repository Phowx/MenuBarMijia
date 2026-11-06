import Foundation
import MijiaCore
import Observation

/// Keeps the "撤销上一步" entry alive after the undo banner expires (#53).
///
/// The store's timestamp remains authoritative when an action finishes before the panel exists.
@Observable
@MainActor
final class UndoAvailabilityTracker {
    static let shared = UndoAvailabilityTracker()

    /// Same window as `HomeStore.undoWindow` (10 minutes).
    static let window: TimeInterval = 10 * 60

    private(set) var lastActionAt: Date?
    @ObservationIgnored private var expiryTask: Task<Void, Never>?
    init() {}

    var isAvailable: Bool {
        lastActionAt != nil
    }

    func syncAction(at date: Date?) {
        expiryTask?.cancel()
        lastActionAt = nil
        guard let date else { return }
        let remaining = Self.window - Date().timeIntervalSince(date)
        guard remaining > 0 else { return }
        lastActionAt = date
        expiryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(remaining))
            guard !Task.isCancelled else { return }
            self?.lastActionAt = nil
        }
    }

    /// Shared button action for the undo button and the panel footer.
    func performUndo(store: HomeStore) async {
        syncAction(at: nil)
        await store.undoLastAction()
        syncAction(at: store.lastActionAt)
    }
}
