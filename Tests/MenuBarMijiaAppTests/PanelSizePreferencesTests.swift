import AppKit
import Foundation
import Testing
@testable import MenuBarMijiaApp

struct PanelSizePreferencesTests {
    @Test("Legacy heights migrate, and saved free dimensions take precedence")
    func legacyAndSavedSizes() throws {
        let suite = "test.panel.size.migrate.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let available = NSSize(width: 1400, height: 1000)
        for (old, height) in [("compact", 460.0), ("standard", 560), ("tall", 680), ("max", 984)] {
            defaults.set(old, forKey: PanelSizePreferences.legacyHeightKey)
            #expect(PanelSizePreferences.load(from: defaults, available: available).height == CGFloat(height))
        }
        PanelSizePreferences.save(NSSize(width: 493, height: 637), to: defaults)
        #expect(PanelSizePreferences.load(from: defaults, available: available) == NSSize(width: 493, height: 637))
        #expect(PanelSizePreferences.load(from: defaults, available: NSSize(width: 400, height: 450)) == NSSize(width: 400, height: 450))
        #expect(PanelSizePreferences.load(from: defaults, available: available) == NSSize(width: 493, height: 637), "A smaller screen must not destroy the preferred size")
    }

    @Test("Minimum dimensions, corrupt preferences and screen bounds stay safe")
    func invalidSizesAndBounds() {
        let available = NSSize(width: 1200, height: 800)
        #expect(PanelSizePreferences.constrained(NSSize(width: 30, height: 40), available: available) == PanelSizePreferences.minimumSize)
        #expect(PanelSizePreferences.constrained(NSSize(width: CGFloat.nan, height: CGFloat.infinity), available: available) == PanelSizePreferences.defaultSize)
        let visible = NSRect(x: 100, y: 100, width: 1000, height: 700)
        let start = NSRect(x: 650, y: 350, width: 376, height: 400)
        for delta in [NSSize(width: 10000, height: 10000), NSSize(width: -10000, height: -10000)] {
            let frame = PanelSizePreferences.draggedFrame(from: start, delta: delta, visibleFrame: visible)
            #expect(visible.contains(frame))
            #expect(frame.width >= PanelSizePreferences.minimumSize.width)
            #expect(frame.height >= PanelSizePreferences.minimumSize.height)
            #expect(frame.maxY == start.maxY)
        }
    }
}
