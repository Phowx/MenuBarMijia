import Foundation
import Testing
@testable import MijiaCore

/// #57: URL Scheme parsing and the confirmation gate are pure logic, so a web page cannot smuggle
/// an unparsed parameter or skip the sheet by default.
struct AppURLCommandTests {
    @Test("Toggle link parses the device id")
    func parsesToggle() throws {
        let url = try #require(URL(string: "menumijia://toggle?device=dev_study_ceiling"))
        #expect(AppURLParser.parse(url) == .toggle(deviceId: "dev_study_ceiling"))
    }

    @Test("Scene link percent-decodes the scene name")
    func parsesScene() throws {
        let url = try #require(URL(string: "menumijia://scene?name=%E5%9B%9E%E5%AE%B6%E6%A8%A1%E5%BC%8F"))
        #expect(AppURLParser.parse(url) == .scene(name: "回家模式"))
    }

    @Test("Retired ask links are rejected without parsing or execution")
    func rejectsRetiredAsk() throws {
        let url = try #require(URL(string: "menumijia://ask?text=%20%E6%89%93%E5%BC%80%E4%B9%A6%E6%88%BF%E7%81%AF%20"))
        #expect(AppURLParser.parse(url) == nil)
    }

    @Test("Path-style links are accepted too")
    func parsesPathStyle() throws {
        let url = try #require(URL(string: "menumijia:/toggle?device=light_bed"))
        #expect(AppURLParser.parse(url) == .toggle(deviceId: "light_bed"))
    }

    @Test("Unknown, incomplete, empty, and oversized links are rejected")
    func rejectsMalformedLinks() throws {
        let bad = [
            "https://toggle?device=light_bed",
            "menumijia://toggle",
            "menumijia://toggle?device=",
            "menumijia://toggle?device=%20",
            "menumijia://scene?name=",
            "menumijia://ask?text=",
            "menumijia://unknown?device=light_bed",
            "menumijia://ask?text=" + String(repeating: "a", count: 500 + 1)
        ]
        for raw in bad {
            let url = try #require(URL(string: raw), "invalid test URL \(raw)")
            #expect(AppURLParser.parse(url) == nil, "\(raw) should not parse")
        }
    }

    @Test("URL control asks for confirmation by default and only skips it after opt-in")
    func confirmationGate() throws {
        let suite = "test.url.gate.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        #expect(URLDirectControl.requiresConfirmation(in: defaults))
        defaults.set(true, forKey: URLDirectControl.allowDirectControlKey)
        #expect(!URLDirectControl.requiresConfirmation(in: defaults))
        #expect(URLDirectControl.requiresConfirmation(allowDirectControl: false))
        #expect(!URLDirectControl.requiresConfirmation(allowDirectControl: true))
    }
}
