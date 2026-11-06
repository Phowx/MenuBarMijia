# Coding Standards

Reviewed by `/code-review` (Standards axis). Mechanical rules (secret scanning, `kVK_*` key constants, `UNUserNotificationCenter` `.app` bundle guard, and `swift test`) are enforced deterministically by `scripts/check.sh`. The rules below cover architectural and domain judgement calls.

## 1. Entity Registry Exclusions Block State Fallbacks

When synthesizing Home Assistant entities in `Sources/MijiaCore/DeviceSynthesizer.swift` with a primary pass over `snapshot.entityRegistry` followed by a fallback pass over `snapshot.states`:

- Record every matched registry `entity_id` into the seen set (`seen...Ids`) **before** skipping `disabled_by != nil || hidden_by != nil` entries.
- Skipping before recording leaks disabled or hidden entities back into the UI through the `states` fallback loop.

## 2. Bidirectional Optimistic Lock on Snapshot Undo

When restoring a `previousDevices` snapshot in `HomeStore` (`UndoBanner` / `undoTurnAllOff`):

- Call `lockOptimistic(dev.id, duration: .seconds(3.0))` for **every device whose state differs** between current `devices` and `banner.previousDevices`.
- Locking only `where dev.isActiveOn` fails when undoing an action (such as `QuickAction.softNightLight`) that turned a previously-off device on, exposing the restored off-state to stale WebSocket frames.

## 3. System Global Resource Lifecycle

System-wide registrations (such as Carbon `RegisterEventHotKey` in `HotkeyAndNotificationManager`) must bind their active registration lifecycle to their preference toggle:

- Call `UnregisterEventHotKey` immediately when `enableGlobalHotkey` is set to `false`, and re-register when set to `true`.
- Leaving a global hotkey registered while ignoring the callback hijacks the key chord from other macOS applications.

## 4. CompactTile Two-Column Alignment

In `ControlCenterPanel` when `isCompactGridMode` is active:

- Devices with an open detail drawer (`expandedDeviceId == dev.id`) render as full-width `.single(dev)` rows (`isCompactTile: false`).
- Unexpanded devices render in two-column `.pair(left, right)` rows (`isCompactTile: true`). When an unexpanded tile has no partner, pair it with `nil` and render a half-width `Color.clear.frame(maxWidth: .infinity)` placeholder so single tiles never stretch full-width.

## 5. Domain Vocabulary & Single Source of Truth

- Keep `MijiaCore` free of `AppKit` / `SwiftUI` imports so all synthesis, optimistic locking, and store state remain fast-testable via `MockHomeProvider`.
- Align type and property names with [`GLOSSARY.md`](GLOSSARY.md) and [`docs/adr/0001-ha-as-single-source-of-truth.md`](docs/adr/0001-ha-as-single-source-of-truth.md).

## 6. Retained Cross-Platform Device Corpora

- MIoT synthesis and command mapping remain covered by `Tests/Fixtures/miot_golden.json` in Swift and Windows; cloud region order remains covered by `region_golden.json`.
- Per ADR-0010, macOS no longer implements language parsing, AI providers, recommendations, habit learning or GrokBall. Their corpora remain for the independent Windows implementation; do not reintroduce retired macOS modules solely for parity.
- Structured actions and undo are shared infrastructure for cards, quick actions and Mac-state automation. They must not depend on a language parser, model configuration or habit recorder.

## 7. Retired Timer Data

- Never schedule or replay legacy `assistant_scheduled_commands_v1` records, regardless of their deadline.
- Preserve the original archive, including malformed data, until the user explicitly confirms clearing it in Settings. Retiring the feature is not permission to silently discard saved records.
- Remove only retired assistant credential accounts; preserve the shared vault and all device credentials. An unreadable vault must never be replaced with a partial one.

## 8. macOS 14+ Adaptive Glass Boundary

- Isolate macOS 26 `.glassEffect(` and `GlassEffectContainer` calls inside `Sources/MenuBarMijiaApp/ThemeAndMotion.swift` (`View.adaptiveGlass` and `AdaptiveGlassContainer`), guarded by `#available(macOS 26.0, *)` with Material fallback for macOS 14 and 15. Enforced mechanically by `scripts/check.sh`.
