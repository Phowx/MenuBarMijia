import Foundation

// MARK: - External URL Scheme (#57)

/// An action requested by a `menumijia://` link from Raycast, Alfred, Stream Deck, a Shortcut, or a
/// web page.
///
/// Links are easy to trigger from a browser, so handlers must not run them silently:
/// `URLDirectControl` decides whether the user has to confirm the action first (default: confirm).
public enum AppURLCommand: Equatable, Sendable {
    case toggle(deviceId: String)
    case scene(name: String)
}

/// Parses `menumijia://toggle?device=<id>`, `menumijia://scene?name=<scene>`,
/// only. Natural-language `ask` links from older versions are rejected.
///
/// Parameters are required, trimmed and length-limited.
public enum AppURLParser {
    public static let scheme = "menumijia"
    public static let maximumNameLength = 200
    public static let maximumURLLength = 4096

    public static func parse(_ url: URL) -> AppURLCommand? {
        guard url.scheme?.lowercased() == scheme,
              url.absoluteString.count <= maximumURLLength,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }

        // `menumijia://toggle?...` puts the route in the host; also accept `menumijia:/toggle?...`.
        let route = (components.host ?? components.path)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .lowercased()

        var query: [String: String] = [:]
        for item in components.queryItems ?? [] {
            let key = item.name.lowercased()
            guard query[key] == nil, let raw = item.value else { continue }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                query[key] = trimmed
            }
        }

        switch route {
        case "toggle":
            guard let deviceId = query["device"], deviceId.count <= maximumNameLength else { return nil }
            return .toggle(deviceId: deviceId)
        case "scene":
            guard let name = query["name"], name.count <= maximumNameLength else { return nil }
            return .scene(name: name)
        default:
            return nil
        }
    }
}

/// Confirmation gate for external links (#57).
///
/// A web page can navigate to a custom URL scheme without any user gesture the app can verify, so
/// every control action asks inside the app first. Only when the user explicitly turns on
/// “允许 URL 直控” in Settings does a link run without the confirmation sheet.
public enum URLDirectControl {
    public static let allowDirectControlKey = "allow_url_direct_control"

    public static func allowsDirectControl(in defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: allowDirectControlKey)
    }

    public static func requiresConfirmation(allowDirectControl: Bool) -> Bool {
        !allowDirectControl
    }

    public static func requiresConfirmation(in defaults: UserDefaults = .standard) -> Bool {
        requiresConfirmation(allowDirectControl: allowsDirectControl(in: defaults))
    }
}
