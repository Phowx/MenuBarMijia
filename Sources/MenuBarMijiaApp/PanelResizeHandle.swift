import AppKit
import SwiftUI
import MijiaCore

/// A visible grip complements the panel's native resizable edges. Event tracking uses screen
/// coordinates so moving the window to stay on screen cannot change the drag's reference point.
struct PanelResizeHandle: NSViewRepresentable {
    func makeNSView(context: Context) -> PanelResizeGrip {
        PanelResizeGrip()
    }

    func updateNSView(_ view: PanelResizeGrip, context: Context) {
        view.toolTip = L10n.tr("拖动调整面板大小，松开后自动保存", "Drag to resize; release to save the panel size")
    }
}

final class PanelResizeGrip: NSView {
    private var startFrame: NSRect?
    private var startPointer: NSPoint?

    override func draw(_ dirtyRect: NSRect) {
        NSColor.secondaryLabelColor.withAlphaComponent(0.55).setStroke()
        let path = NSBezierPath()
        path.lineWidth = 1
        for offset: CGFloat in [5, 9, 13] {
            path.move(to: NSPoint(x: bounds.maxX - offset, y: 3))
            path.line(to: NSPoint(x: bounds.maxX - 3, y: offset))
        }
        path.stroke()
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .crosshair)
    }

    override func mouseDown(with event: NSEvent) {
        guard let window, window.delegate is MenuBarPanelController else { return }
        startFrame = window.frame
        startPointer = window.convertPoint(toScreen: event.locationInWindow)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let controller = window.delegate as? MenuBarPanelController,
              let startFrame, let startPointer else { return }
        let point = window.convertPoint(toScreen: event.locationInWindow)
        controller.resizePanel(from: startFrame, delta: NSSize(width: point.x - startPointer.x, height: startPointer.y - point.y))
    }

    override func mouseUp(with event: NSEvent) {
        guard startFrame != nil else { return }
        (window?.delegate as? MenuBarPanelController)?.rememberPanelSize()
        startFrame = nil
        startPointer = nil
    }
}
