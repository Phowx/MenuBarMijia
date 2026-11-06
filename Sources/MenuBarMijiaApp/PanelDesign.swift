import SwiftUI
import AppKit
import MijiaCore

// MARK: - Remembered Panel Size

/// Window dimensions are independent of card layout and are only written after a user resize.
/// Screen changes clamp the displayed size without overwriting the remembered preference.
enum PanelSizePreferences {
    static let widthKey = "panel_width_points"
    static let heightKey = "panel_height_points"
    static let legacyHeightKey = "panel_height"
    static let defaultSize = NSSize(width: 376, height: 560)
    static let minimumSize = NSSize(width: 340, height: 360)

    static func constrained(_ size: NSSize, available: NSSize) -> NSSize {
        let width = size.width.isFinite && size.width > 0 ? size.width : defaultSize.width
        let height = size.height.isFinite && size.height > 0 ? size.height : defaultSize.height
        let maxWidth = max(1, available.width)
        let maxHeight = max(1, available.height)
        return NSSize(
            width: min(max(width, minimumSize.width), maxWidth).rounded(),
            height: min(max(height, minimumSize.height), maxHeight).rounded()
        )
    }

    static func load(from defaults: UserDefaults, available: NSSize) -> NSSize {
        let width = (defaults.object(forKey: widthKey) as? NSNumber)?.doubleValue ?? defaultSize.width
        let height: CGFloat
        if let saved = defaults.object(forKey: heightKey) as? NSNumber {
            height = saved.doubleValue
        } else {
            switch defaults.string(forKey: legacyHeightKey) {
            case "compact": height = 460
            case "tall": height = 680
            case "max": height = max(460, available.height - 16)
            default: height = defaultSize.height
            }
        }
        return constrained(NSSize(width: width, height: height), available: available)
    }

    static func save(_ size: NSSize, to defaults: UserDefaults) {
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { return }
        defaults.set(size.width, forKey: widthKey)
        defaults.set(size.height, forKey: heightKey)
    }

    static func reset(in defaults: UserDefaults) {
        for key in [widthKey, heightKey, legacyHeightKey] { defaults.removeObject(forKey: key) }
    }

    static func draggedFrame(from start: NSRect, delta: NSSize, visibleFrame: NSRect) -> NSRect {
        let limits = visibleFrame.insetBy(dx: 8, dy: 8)
        let top = min(start.maxY, limits.maxY)
        let available = NSSize(width: limits.width, height: top - limits.minY)
        let size = constrained(NSSize(width: start.width + delta.width, height: start.height + delta.height), available: available)
        let x = min(max(start.minX, limits.minX), limits.maxX - size.width)
        return NSRect(x: x, y: top - size.height, width: size.width, height: size.height)
    }
}

// MARK: - Appearance

/// Panel appearance: follow the system, or force light/dark.
public enum AppAppearance: String, CaseIterable, Identifiable, Sendable {
    case system, light, dark

    public static let storageKey = "app_appearance"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .system: return L10n.tr("跟随系统", "Follow System")
        case .light: return L10n.tr("浅色", "Light")
        case .dark: return L10n.tr("深色", "Dark")
        }
    }

    /// `nil` means "use the system colour scheme".
    public var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    /// `nil` inherits the system appearance on `NSWindow` / `NSView`.
    public var nsAppearance: NSAppearance? {
        switch self {
        case .system: return nil
        case .light: return NSAppearance(named: .aqua)
        case .dark: return NSAppearance(named: .darkAqua)
        }
    }
}

// MARK: - System Panel Look

/// One system design, no skins. Tiles mirror Control Center: anything that is on gets the loudest
/// surface the appearance allows — an opaque bright platter in light mode, a lifted well one step
/// above the quiet off-state glass in dark mode, where a white slab would glare and force the ink
/// inside it back to the light scheme. `TileSurface` derives ink, fill and hairline together so no
/// caller has to reason about the pairing.
public enum PanelLook {
    public static let tileRadius: CGFloat = 14

    /// Ink for the light-mode platter. `Color.primary` is white in dark mode, so the bright platter
    /// carries its own fixed dark ink instead of following the window scheme.
    public static let platterInk = DesignTokens.Ink.onPlatter

    /// Soft drop shadow that keeps the platter above the glass; wells stay flat.
    public static func platterShadow(isActive: Bool) -> Color {
        isActive ? Color.black.opacity(0.18) : .clear
    }
}

/// One tile's presentation state: lit or quiet, and when lit, on the light-mode platter or the
/// family-coloured glass. Ink, fill and hairline all derive from it, so callers pass one value
/// instead of repeating the active/tint/scheme triple.
public struct TileSurface: Equatable, Sendable {
    public var isActive: Bool
    public var tint: Color?
    public var scheme: ColorScheme

    public init(isActive: Bool, tint: Color? = nil, scheme: ColorScheme) {
        self.isActive = isActive
        self.tint = tint
        self.scheme = scheme
    }

    /// Ink on the lit surface. Every lit surface in dark mode is dark glass, so it keeps white ink;
    /// only the light-mode platter needs the fixed dark ink.
    public var ink: Color {
        if isActive, scheme == .dark { return .white }
        return isActive ? PanelLook.platterInk : .primary
    }

    public var secondaryInk: Color {
        if isActive, scheme == .dark { return Color.white.opacity(0.62) }
        return isActive ? PanelLook.platterInk.opacity(0.55) : Color.secondary
    }

    /// The tile fill: bright platter when lit in light mode, one step above the well when lit in dark
    /// mode; a tint swaps either for a wash of the family colour so the hue carries the state.
    public var fill: AnyShapeStyle {
        if isActive, let tint {
            return scheme == .dark
                ? AnyShapeStyle(LinearGradient(colors: [tint.opacity(0.24), Color.white.opacity(0.08)], startPoint: .topLeading, endPoint: .bottomTrailing))
                : AnyShapeStyle(LinearGradient(colors: [tint.opacity(0.14), Color.white.opacity(0.92)], startPoint: .topLeading, endPoint: .bottomTrailing))
        }
        if scheme == .dark {
            // Never a white slab in dark mode: it glares, and every bit of ink inside it would have
            // to flip back to the light scheme. A lit tile is simply a brighter well.
            return AnyShapeStyle(Color.white.opacity(isActive ? 0.17 : 0.07))
        }
        return isActive ? AnyShapeStyle(Color.white) : AnyShapeStyle(Color.black.opacity(0.045))
    }

    public var hairline: Color {
        if isActive, let tint {
            return tint.opacity(scheme == .dark ? 0.38 : 0.30)
        }
        if isActive { return scheme == .dark ? Color.white.opacity(0.12) : Color.black.opacity(0.07) }
        return scheme == .dark ? Color.white.opacity(0.09) : Color.black.opacity(0.05)
    }
}

// MARK: - Motion Helpers

/// Repeating halo used for the microphone while listening.
struct ListeningPulse: ViewModifier {
    let active: Bool
    let color: Color
    @State private var phase = false

    func body(content: Content) -> some View {
        content
            .background {
                if active {
                    Capsule(style: .continuous)
                        .stroke(color.opacity(phase ? 0 : 0.7), lineWidth: 2)
                        .scaleEffect(phase ? 1.6 : 1)
                        .onAppear {
                            phase = false
                            withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { phase = true }
                        }
                }
            }
    }
}

/// Status dot that breathes slowly while connected.
struct BreathingDot: View {
    @Environment(\.effectiveReduceMotion) private var reduceMotion
    let color: Color
    let animate: Bool
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .opacity(dim ? 0.35 : 1)
            .onAppear {
                guard animate, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { dim = true }
            }
    }
}

extension View {
    /// Adds a shadow only when `active`; a clear shadow still costs an offscreen pass per frame.
    @ViewBuilder
    func shadowIf(_ active: Bool, color: Color, radius: CGFloat, x: CGFloat = 0, y: CGFloat = 0) -> some View {
        if active { self.shadow(color: color, radius: radius, x: x, y: y) } else { self }
    }

    func listeningPulse(_ active: Bool, color: Color) -> some View { modifier(ListeningPulse(active: active, color: color)) }

    /// System tooltip. Kept as one wrapper so the panel can drop tooltips in one place.
    func panelHelp(_ text: String) -> some View { help(text) }
}

// MARK: - Hold-to-Confirm All Off

/// "All Off" control: press and hold 0.6s to fire, with a filling progress sweep.
struct HoldToConfirmButton: View {
    let title: String
    let count: Int
    let onConfirm: () -> Void
    let onTap: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var holding = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "power").font(.system(size: DesignTokens.TypeSize.micro, weight: .bold))
            Text(title).font(.system(size: DesignTokens.TypeSize.control, weight: .semibold))
            Text("(\(count))")
                .font(.system(size: DesignTokens.TypeSize.control, weight: .semibold))
                .monospacedDigit()
                .contentTransition(.numericText(value: Double(count)))
        }
        .foregroundStyle(Color.white)
        .padding(.horizontal, 11)
        .padding(.vertical, 5)
        .background {
            ZStack(alignment: .leading) {
                Capsule(style: .continuous).fill(DesignTokens.Brand.allOff)
                GeometryReader { geo in
                    Rectangle()
                        .fill(Color.black.opacity(0.2))
                        .frame(width: holding ? geo.size.width : 0)
                }
                .clipShape(Capsule(style: .continuous))
            }
        }
        .scaleEffect(holding ? 0.95 : 1)
        .contentShape(Capsule(style: .continuous))
        .onTapGesture(perform: onTap)
        .onLongPressGesture(minimumDuration: 0.6, maximumDistance: 20) {
            holding = false
            // #54: a confirm that turns off the whole room deserves a level-change tap.
            NSHapticFeedbackManager.defaultPerformer.perform(.levelChange, performanceTime: .now)
            onConfirm()
        } onPressingChanged: { pressing in
            withAnimation(pressing ? .linear(duration: 0.6) : .easeOut(duration: 0.2)) { holding = pressing }
        }
        .panelHelp(L10n.tr("按住 0.6 秒关闭这 \(count) 台设备", "Hold 0.6s to turn off these \(count) devices"))
        // VoiceOver cannot long-press easily; give it an explicit, clearly named action instead.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(title) (\(count))"))
        .accessibilityHint(Text(L10n.tr("按住 0.6 秒关闭", "Hold 0.6 seconds to turn off")))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: Text(L10n.tr("关闭这 \(count) 台设备", "Turn off these \(count) devices"))) {
            NSHapticFeedbackManager.defaultPerformer.perform(.levelChange, performanceTime: .now)
            onConfirm()
        }
        .opacity(colorScheme == .dark ? 1 : 0.98)
    }
}

// MARK: - Panel Root

/// Panel root: one system material behind every state, with the forced appearance and the
/// "Reduce transparency" fallback (#41).
public struct PanelRoot: ViewModifier {
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.effectiveReduceTransparency) private var reduceTransparency
    @AppStorage(AppAppearance.storageKey) private var appearanceRaw: String = AppAppearance.system.rawValue

    public func body(content: Content) -> some View {
        let scheme = (AppAppearance(rawValue: appearanceRaw) ?? .system).colorScheme ?? systemScheme
        content
            .background {
                if reduceTransparency {
                    Rectangle().fill(Color(nsColor: .windowBackgroundColor))
                } else if #available(macOS 26.0, *) {
                    // Native Liquid Glass replaces the hand-stacked material+scrim; the wrapper
                    // keeps the macOS 26 API inside ThemeAndMotion. A lighter scrim still pins the
                    // chosen appearance: over a bright wallpaper the dark scheme must stay dark or
                    // white text loses contrast.
                    Color.clear
                        .panelRootGlass()
                    Rectangle().fill(scheme == .dark ? Color.black.opacity(0.30) : Color.white.opacity(0.18))
                } else {
                    // A thin material alone picks up whatever is behind the window: over a bright
                    // wallpaper the dark scheme stays light and white text loses contrast. The scrim
                    // pins the surface to the chosen appearance without losing the glass.
                    Rectangle().fill(.ultraThinMaterial)
                    Rectangle().fill(scheme == .dark ? Color.black.opacity(0.42) : Color.white.opacity(0.32))
                }
            }
            .environment(\.colorScheme, scheme)
    }
}

extension View {
    public func panelRoot() -> some View { modifier(PanelRoot()) }
}

// MARK: - Panel Preferences

/// Storage keys that are not a user-visible choice but still persist between launches.
public enum PanelPrefs {
    public static let climatePanelKey = "climate_panel_module"
}
