import { HomeAssistantClient, homeAssistantIdentity, homeAssistantCommand, parseCachedHAHome } from "../core/homeAssistant.js";
import { pinyin } from "pinyin-pro";
import type { SynthesizedHome } from "../core/models.js";
import { IntentReply, IntentValidator } from "../core/assistant.js";
import {
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  MI_CLOUD_REGIONS,
  MiAccountLogin,
  MiCloudClient,
  MiotCommandMapper,
  type MiotDeviceSpec,
  type MiotPropKey,
  MiotSpecResolver,
  MiotSynthesizer,
  type MiSession,
  type QRLoginTicket,
  maskedMiUserId,
  miCloudRegionLabel,
  normalizeMiCloudRegion,
} from "../core/miCloudClient.js";
import {
  CredentialVault,
  credentialsFromSettings,
  hasCredentials,
  parseMiSession,
  sanitizeSettingsForStorage,
  sessionWithoutPassToken,
} from "../core/secureStore.js";
import {
  type DeviceCommand,
  type DeviceIntent,
  type IntentOperation,
  type EnvironmentReading,
  type HomeScene,
  type SmartDevice,
  allOffTargets,
  cloudRefreshDue,
  deviceEnvironmentReading,
  deviceStatusSummary,
  environmentReadingPriority,
  isDeviceActiveOn,
  joinsAllOff,
  joinsAllOffByDefault,
  localizeNightShot,
  localizeAirQuality,
  localizeFanPreset,
} from "../core/models.js";
import {
  type AppAppearance,
  type AppSkin,
  type LayoutPrefs,
  type PanelHeight,
  type TileSize,
  APPEARANCES,
  DEFAULT_GLOBAL_SHORTCUT,
  PANEL_HEIGHTS,
  SKINS,
  TILE_SIZES,
  applyOrder,
  targetSize,
  releaseVelocity,
  projectedOffset,
  chosenSize,
  comfort,
  emptyLayoutPrefs,
  homeOptions,
  localizeEffect,
  localizeFanMode,
  moveInOrder,
  nextSize,
  normalizeGlobalShortcut,
  pageSections,
  recordShortcutFromKeyEvent,
  resolveAppearance,
  resolvedSize,
  scopedKey,
  spans,
  withAliases,
  type HomeOption,
} from "./panelPrefs.js";
import {
  type AppLanguage,
  type LanguagePreference,
  resolveLanguage,
  setLanguage,
  t,
} from "../core/i18n.js";
import {
  type TemperatureUnitPreference,
  applyTemperatureUnit,
  displayStep,
  formatTemperature,
  formatTemperatureValue,
  getTemperatureUnit,
  stepCelsius,
  temperatureSymbol,
  toCelsius,
} from "../core/temperature.js";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    };
  }
}

type ConnectionMode = "demo" | "xiaomiCloud" | "homeAssistant";

interface PersistedSettings {
  connectionMode: ConnectionMode;
  miSession: MiSession | null;
  /** Non-sensitive Xiaomi cloud region for the next QR login (#37); the session keeps the region it logged in with. */
  miCloudRegion: string;
  haBaseURL: string;
  haToken: string;
  // Retain the existing credential vault entry on upgrade.
  openRouterApiKey: string;
  /** Per-device choice for 全关; missing means the default (plugs and vacuums stay out) (#23). */
  allOffOverrides: Record<string, boolean>;
  hasCompletedOnboarding: boolean;
  isCompactGridMode: boolean;
  cachedXiaomiDevices: SmartDevice[];
  cachedHAHome: { identity: string; home: SynthesizedHome } | null;
  cachedModelTypes: Record<string, string>;
  skin: AppSkin;
  appearance: AppAppearance;
  panelHeight: PanelHeight;
  panelSize: { width: number; height: number } | null;
  climatePanel: boolean;
  layout: LayoutPrefs;
  /** Selected Mi Home id; null shows every home. */
  selectedHomeId: string | null;
  /** UI language (#52); `system` follows the OS language, and the speech recognizer follows the UI. */
  interfaceLanguage: LanguagePreference;
  /** °C/°F display (#52); stored/command values stay Celsius. */
  temperatureUnit: TemperatureUnitPreference;
  /** Whether the system-wide tray shortcut is registered (#43). */
  enableGlobalHotkey: boolean;
  /** Canonical global shortcut string (default `"Alt+M"`, #43). */
  globalHotkey: string;
  /** Per-camera custom stream URLs (e.g. local go2rtc / HLS), persisted across restarts. */
  cameraStreamURLs?: Record<string, string>;
}

interface UndoStep {
  readonly deviceId: string;
  readonly commands: readonly DeviceCommand[];
}

interface UndoAction {
  readonly summary: string;
  readonly steps: readonly UndoStep[];
  readonly expiresAtMs: number;
}

interface ReplyBannerState {
  readonly text: string;
  readonly source: string;
  readonly isError?: boolean;
  readonly isCloudSyncError?: boolean;
}

const STORAGE_KEY = "menumijia.windows.settings.v2";
// The #52 language/unit preferences live inside the one settings blob above, so a save writes them
// atomically with the rest; `i18n.ts` and `temperature.ts` expose matching standalone keys for tools.
const LEGACY_STORAGE_KEY = "menumijia.windows.settings.v1";
const DEFAULT_PANEL_SIZE = { width: 480, height: 620 };
const MIN_PANEL_SIZE = { width: 360, height: 380 };

function storedPanelSize(size: unknown): PersistedSettings["panelSize"] {
  if (!size || typeof size !== "object" || !("width" in size) || !("height" in size)) return null;
  const { width, height } = size;
  return typeof width === "number" && Number.isFinite(width) && width >= MIN_PANEL_SIZE.width &&
    typeof height === "number" && Number.isFinite(height) && height >= MIN_PANEL_SIZE.height
    ? { width, height } : null;
}

// Injected at build time by vite.config.ts from the repository's VERSION file (#39).
const APP_VERSION =
  typeof __APP_VERSION__ === "string" && __APP_VERSION__.trim() !== "" ? __APP_VERSION__.trim() : "0.0.0";

// Crisp Apple SF-Symbol-matched vector icons (zero Windows emojis)
const SF_ICONS = {
  houseFill: `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h3a1 1 0 001-1v-3a1 1 0 011-1h0a1 1 0 011 1v3a1 1 0 001 1h3a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z"/></svg>`,
  lightbulbFill: `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 2a6 6 0 00-3.815 10.631C7.237 13.5 8 14.443 8 15.5v.5a2 2 0 002 2h0a2 2 0 002-2v-.5c0-1.057.763-2 1.815-2.869A6 6 0 0010 2zm-1.5 15.5h3a.5.5 0 010 1h-3a.5.5 0 010-1z"/></svg>`,
  snowflake: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v16M2 10h16M4.93 4.93l10.14 10.14M15.07 4.93L4.93 15.07M10 4.5L8 2.5M10 4.5l2-2M10 15.5l-2 2M10 15.5l2 2"/></svg>`,
  fanbladesFill: `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 8.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6zm.5-6.2c-2.2 0-3.6 1.8-2.9 3.9.3.8.8 1.5 1.5 1.9.3-.2.6-.3.9-.3.7 0 1.3.4 1.6 1 .8-.6 1.4-1.7 1.4-3.1C13 3.4 11.9 2 10.5 2zm7.5 8.5c0-2.2-1.8-3.6-3.9-2.9-.8.3-1.5.8-1.9 1.5.2.3.3.6.3.9 0 .7-.4 1.3-1 1.6.6.8 1.7 1.4 3.1 1.4 2 0 3.4-1.1 3.4-2.5zM9.5 18c2.2 0 3.6-1.8 2.9-3.9-.3-.8-.8-1.5-1.5-1.9-.3.2-.6.3-.9.3-.7 0-1.3-.4-1.6-1-.8.6-1.4 1.7-1.4 3.1 0 2 1.1 3.4 2.5 3.4zM2 9.5c0 2.2 1.8 3.6 3.9 2.9.8-.3 1.5-.8 1.9-1.5-.2-.3-.3-.6-.3-.9 0-.7.4-1.3 1-1.6-.6-.8-1.7-1.4-3.1-1.4-2 0-3.4 1.1-3.4 2.5z"/></svg>`,
  powerplugFill: `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M7 2a1 1 0 011 1v3h4V3a1 1 0 112 0v3h1a1 1 0 011 1v2.5a5.5 5.5 0 01-4.5 5.408V17a1 1 0 11-2 0v-2.092A5.5 5.5 0 014 9.5V7a1 1 0 011-1h1V3a1 1 0 011-1z"/></svg>`,
  sparkles: `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10.8 2.4a.6.6 0 00-1.1 0L8.1 6.3a2.2 2.2 0 01-1.2 1.2L3 9.1a.6.6 0 000 1.1l3.9 1.6c.5.2 1 .7 1.2 1.2l1.6 3.9a.6.6 0 001.1 0l1.6-3.9c.2-.5.7-1 1.2-1.2l3.9-1.6a.6.6 0 000-1.1l-3.9-1.6a2.2 2.2 0 01-1.2-1.2L10.8 2.4zM15.8 13.2a.4.4 0 00-.7 0l-.6 1.4-.4.4-1.4.6a.4.4 0 000 .7l1.4.6.4.4.6 1.4a.4.4 0 00.7 0l.6-1.4.4-.4 1.4-.6a.4.4 0 000-.7l-1.4-.6-.4-.4-.6-1.4z"/></svg>`,
  sensorFill: `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 3a2.5 2.5 0 00-2.5 2.5v6.085a4 4 0 105 0V5.5A2.5 2.5 0 0010 3zm0 1.5a1 1 0 011 1v6.6a.75.75 0 00.32.614 2.5 2.5 0 11-2.64 0 .75.75 0 00.32-.614V5.5a1 1 0 011-1z"/></svg>`,
  search: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4" stroke-linecap="round"/></svg>`,
  arrowClockwise: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 4.5v4h-4"/><path d="M15.8 12.8a6.2 6.2 0 11-1.3-6.6L16.5 8.5"/></svg>`,
  sliderHorizontal: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 5.5h9M15 5.5h2M3 10h3M9 10h8M3 14.5h7M13 14.5h4"/><circle cx="13.5" cy="5.5" r="1.6" fill="currentColor"/><circle cx="7.5" cy="10" r="1.6" fill="currentColor"/><circle cx="11.5" cy="14.5" r="1.6" fill="currentColor"/></svg>`,
  power: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"><path d="M10 2.8v6.4M6.1 4.8a6.2 6.2 0 107.8 0"/></svg>`,
  chevronRight: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 4.5L13 10l-5.5 5.5"/></svg>`,
  chevronDown: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7.5L10 12.5 15 7.5"/></svg>`,
  sunMaxFill: `<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="10" cy="10" r="3.6"/><path stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M10 2.2v2M10 15.8v2M2.2 10h2M15.8 10h2M4.48 4.48l1.42 1.42M14.1 14.1l1.42 1.42M15.52 4.48L14.1 5.9M5.9 14.1l-1.42 1.42"/></svg>`,
  moonStarsFill: `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M14.9 13.3A6.5 6.5 0 017.7 4.1a.6.6 0 00-.78-.75 7.2 7.2 0 108.73 9.73.6.6 0 00-.75-.78z"/></svg>`,
  boltFill: `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M11.3 1.9L4.6 10.6a.6.6 0 00.48.96H9.5l-.8 6.54a.5.5 0 00.89.36l6.7-8.7a.6.6 0 00-.48-.96H11.4l.79-6.54a.5.5 0 00-.89-.36z"/></svg>`,
  grid2x2: `<svg viewBox="0 0 20 20" fill="currentColor"><rect x="3" y="3" width="6" height="6" rx="1.6"/><rect x="11" y="3" width="6" height="6" rx="1.6"/><rect x="3" y="11" width="6" height="6" rx="1.6"/><rect x="11" y="11" width="6" height="6" rx="1.6"/></svg>`,
  grid1x2: `<svg viewBox="0 0 20 20" fill="currentColor"><rect x="3" y="3.5" width="14" height="5.2" rx="1.6"/><rect x="3" y="11.3" width="14" height="5.2" rx="1.6"/></svg>`,
  qrcode: `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M3 3h6v6H3V3zm1.5 1.5v3h3v-3h-3zM11 3h6v6h-6V3zm1.5 1.5v3h3v-3h-3zM3 11h6v6H3v-6zm1.5 1.5v3h3v-3h-3zM11 11h2.5v2.5H11V11zm3.5 0H17v2.5h-2.5V11zM11 14.5h2.5V17H11v-2.5zm3.5 0H17V17h-2.5v-2.5z"/></svg>`,
  xmark: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>`,
  videoFill: `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M3 5a2 2 0 012-2h7a2 2 0 012 2v1.8l3.1-1.85A.75.75 0 0118.25 5.6v8.8a.75.75 0 01-1.15.65L14 13.2V15a2 2 0 01-2 2H5a2 2 0 01-2-2V5z"/></svg>`,
};

/** Demo home, materialised per language so the preview text follows the UI (#52). */
function demoDevices(): SmartDevice[] {
  return [
  {
    id: "light.living_ceiling",
    name: t(t("客厅吸顶灯")),
    roomId: "room_living",
    roomName: t(t("客厅")),
    model: "yeelink.light.ceiling22",
    isOnline: true,
    kind: {
      kind: "light",
      entityId: "miot:light.living_ceiling:2",
      isOn: true,
      brightnessPercent: 78,
      colorTempKelvin: 4100,
      minKelvin: 2700,
      maxKelvin: 6500,
      currentEffect: "Day",
      availableEffects: ["Day", "Night"],
    },
  },
  {
    id: "climate.living_ac",
    name: t(t("客厅立式空调")),
    roomId: "room_living",
    roomName: t(t("客厅")),
    model: "xiaomi.aircondition.mc5",
    isOnline: true,
    kind: {
      kind: "climate",
      entityId: "miot:climate.living_ac:2",
      isOn: true,
      hvacMode: "cool",
      availableModes: ["cool", "heat", "dry", "fan_only", "auto", "off"],
      targetTemperature: 25,
      currentTemperature: 26,
      minTemp: 16,
      maxTemp: 30,
      step: 0.5,
      fanMode: "auto",
      availableFanModes: ["auto", "low", "medium", "high"],
    },
  },
  {
    id: "light.study_desk",
    name: t(t("书房台灯")),
    roomId: "room_study",
    roomName: t(t("书房")),
    model: "yeelink.light.lamp15",
    isOnline: true,
    kind: {
      kind: "light",
      entityId: "miot:light.study_desk:2",
      isOn: true,
      brightnessPercent: 64,
      colorTempKelvin: 4600,
      minKelvin: 2700,
      maxKelvin: 6500,
      currentEffect: null,
      availableEffects: ["Day", "Night"],
    },
  },
  {
    id: "fan.bedroom_standing",
    name: t(t("主卧直流风扇")),
    roomId: "room_bedroom",
    roomName: t(t("主卧")),
    model: "zhimi.fan.za5",
    isOnline: true,
    kind: {
      kind: "fan",
      entityId: "miot:fan.bedroom_standing:2",
      isOn: false,
      percentage: 50,
      presetMode: "Level 2",
      availablePresetModes: ["Level 1", "Level 2", "Level 3", "Level 4"],
      isOscillating: false,
    },
  },
  {
    id: "plug.entry_socket",
    name: t(t("玄关智能插座")),
    roomId: "room_entry",
    roomName: t(t("玄关")),
    model: "cuco.plug.cp1",
    isOnline: true,
    kind: {
      kind: "plug",
      switchEntityId: "miot:plug.entry_socket:2",
      isOn: true,
      powerWatts: 18.4,
      childLockEntityId: null,
      isChildLocked: false,
    },
  },
  {
    id: "vacuum.roborock",
    name: t(t("全屋扫拖机器人")),
    roomId: "room_living",
    roomName: t(t("客厅")),
    model: "roborock.vacuum.a15",
    isOnline: true,
    kind: {
      kind: "vacuum",
      entityId: "miot:vacuum.roborock:2",
      status: "docked",
      battery: 100,
      modeEntityId: null,
      currentMode: null,
      availableModes: [],
    },
  },
  {
    id: "sensor.living_env",
    name: t(t("客厅温湿度计")),
    roomId: "room_living",
    roomName: t(t("客厅")),
    model: "miaomiaoce.sensor_ht.t2",
    isOnline: true,
    kind: {
      kind: "sensor",
      temperature: 25.5,
      humidity: 52,
      battery: 94,
    },
  },
  {
    id: "camera.living_cam",
    name: t(t("客厅摄像机")),
    roomId: "room_living",
    roomName: t(t("客厅")),
    model: "chuangmi.camera.81ac1",
    isOnline: true,
    kind: {
      kind: "camera",
      entityId: "miot:camera.living_cam:2",
      isOn: true,
      nightShot: "Auto",
      availableNightShots: ["Off", "On", "Auto"],
      motionDetectionEntityId: "miot:camera.living_cam:5",
      isMotionDetectionOn: true,
      streamEntityId: "miot:camera.living_cam:20",
    },
  },
  ];
}

function demoScenes(): HomeScene[] {
  return [
    { id: "scene.home", name: t(t("回家模式")), entityId: "scene.home" },
    { id: "scene.focus", name: t(t("专注模式")), entityId: "scene.focus" },
    { id: "scene.sleep", name: t(t("睡眠模式")), entityId: "scene.sleep" },
    { id: "scene.leave", name: t(t("离家模式")), entityId: "scene.leave" },
  ];
}

function quickActions(): ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly tint: string;
  readonly deviceKind: "light" | "climate";
  readonly operations: readonly IntentOperation[];
}> {
  return [
    { id: "lights_on", title: t("全开主灯"), icon: SF_ICONS.sunMaxFill, tint: "amber", deviceKind: "light", operations: [{ kind: "power", isOn: true }] },
    { id: "lights_off", title: t("睡眠关灯"), icon: SF_ICONS.moonStarsFill, tint: "indigo", deviceKind: "light", operations: [{ kind: "power", isOn: false }] },
    { id: "cool_25", title: t("25°制冷"), icon: SF_ICONS.snowflake, tint: "cyan", deviceKind: "climate", operations: [{ kind: "hvacMode", mode: "cool" }, { kind: "targetTemperature", celsius: 25 }] },
    { id: "focus", title: t("调亮灯光"), icon: SF_ICONS.lightbulbFill, tint: "amber", deviceKind: "light", operations: [{ kind: "brightnessStep", delta: 20 }] },
  ];
}

function createTransport(): HttpTransport {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    if (window.__TAURI_INTERNALS__?.invoke) {
      return window.__TAURI_INTERNALS__.invoke<HttpResponse>("native_http", {
        url: req.url,
        method: req.method ?? "GET",
        headers: req.headers ?? {},
        body: req.body ?? null,
        followRedirects: req.followRedirects ?? true,
        timeoutMs: req.timeoutMs ?? 15000,
      });
    }
    const response = await fetch(req.url, {
      method: req.method ?? "GET",
      headers: req.headers,
      body: req.body,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      headers,
      body: await response.text(),
    };
  };
}

function invokeTauriVoid(cmd: string, args?: Record<string, unknown>): void {
  if (window.__TAURI_INTERNALS__?.invoke) {
    void window.__TAURI_INTERNALS__.invoke(cmd, args);
  }
}

interface LoadedSettings {
  readonly settings: PersistedSettings;
  /** An old localStorage copy still contains secrets that must move to the credential manager (#28). */
  readonly hasLegacyCredentials: boolean;
}
function upgradeCachedDevices(devices: SmartDevice[]): SmartDevice[] {
  return devices.map((dev) => {
    const m = dev.model.toLowerCase();
    if (
      dev.kind.kind === "plug" &&
      (m.includes("camera") || m.includes("cateye") || m.includes("doorbell"))
    ) {
      return {
        ...dev,
        kind: {
          kind: "camera",
          entityId: dev.kind.switchEntityId,
          isOn: dev.kind.isOn,
          nightShot: "Auto",
          availableNightShots: ["Off", "On", "Auto"],
          motionDetectionEntityId: null,
          isMotionDetectionOn: null,
          streamEntityId: null,
        },
      };
    }
    return dev;
  });
}



function loadSettings(): LoadedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedSettings> & Record<string, unknown>;
      const rawHaToken = typeof parsed.haToken === "string" ? parsed.haToken : "";
      const rawApiKey = typeof parsed.openRouterApiKey === "string" ? parsed.openRouterApiKey : "";
      const hasLegacyCredentials =
        (parsed.miSession !== undefined && parsed.miSession !== null) || rawHaToken !== "" || rawApiKey !== "";
      const miSession = parseMiSession(parsed.miSession);
      const mode: ConnectionMode = parsed.connectionMode === "demo" || parsed.connectionMode === "xiaomiCloud" || parsed.connectionMode === "homeAssistant"
        ? parsed.connectionMode
        : miSession ? "xiaomiCloud" : "demo";
      return {
        settings: {
          connectionMode: mode,
          miSession,
          miCloudRegion: normalizeMiCloudRegion(parsed.miCloudRegion ?? miSession?.region),
          haBaseURL: parsed.haBaseURL ?? "",
          haToken: rawHaToken,
          openRouterApiKey: rawApiKey,
          allOffOverrides:
            parsed.allOffOverrides && typeof parsed.allOffOverrides === "object"
              ? Object.fromEntries(
                  Object.entries(parsed.allOffOverrides).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
                )
              : {},
          hasCompletedOnboarding: parsed.hasCompletedOnboarding ?? Boolean(miSession),
          isCompactGridMode: parsed.isCompactGridMode ?? true,
          cachedXiaomiDevices: Array.isArray(parsed.cachedXiaomiDevices)
            ? upgradeCachedDevices(parsed.cachedXiaomiDevices)
            : [],
          cachedHAHome: parseCachedHAHome(parsed.cachedHAHome),
          cachedModelTypes:
            parsed.cachedModelTypes && typeof parsed.cachedModelTypes === "object"
              ? parsed.cachedModelTypes
              : {},
          skin: SKINS.some((k) => k.id === parsed.skin) ? (parsed.skin as AppSkin) : "classic",
          appearance:
            parsed.appearance === "light" || parsed.appearance === "dark"
              ? parsed.appearance
              : "system",
          panelHeight: PANEL_HEIGHTS.some((h) => h.id === parsed.panelHeight) ? (parsed.panelHeight as PanelHeight) : "standard",
          panelSize: storedPanelSize(parsed.panelSize),
          climatePanel: parsed.climatePanel ?? true,
          interfaceLanguage:
            parsed.interfaceLanguage === "zh-Hans" || parsed.interfaceLanguage === "en"
              ? parsed.interfaceLanguage
              : "system",
          temperatureUnit:
            parsed.temperatureUnit === "celsius" || parsed.temperatureUnit === "fahrenheit"
              ? parsed.temperatureUnit
              : "system",
          enableGlobalHotkey: typeof parsed.enableGlobalHotkey === "boolean" ? parsed.enableGlobalHotkey : true,
          globalHotkey: normalizeGlobalShortcut(parsed.globalHotkey),
          cameraStreamURLs:
            parsed.cameraStreamURLs && typeof parsed.cameraStreamURLs === "object"
              ? Object.fromEntries(
                  Object.entries(parsed.cameraStreamURLs as Record<string, unknown>).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
                  ),
                )
              : {},
          layout: { ...emptyLayoutPrefs(), ...(parsed.layout ?? {}) },
          selectedHomeId: parsed.selectedHomeId ?? null,
        },
        hasLegacyCredentials,
      };
    }
  } catch {
    // ignore corrupt localStorage
  }
  return {
    settings: {
      connectionMode: "demo",
      miSession: null,
      miCloudRegion: "cn",
      haBaseURL: "",
      haToken: "",
      openRouterApiKey: "",
      allOffOverrides: {},
      hasCompletedOnboarding: false,
      isCompactGridMode: true,
      cachedXiaomiDevices: [],
      cachedHAHome: null,
      cachedModelTypes: {},
      skin: "classic",
      appearance: "system",
      panelHeight: "standard",
      panelSize: null,
      climatePanel: true,
      layout: emptyLayoutPrefs(),
      selectedHomeId: null,
      interfaceLanguage: "system",
      temperatureUnit: "system",
      enableGlobalHotkey: true,
      globalHotkey: DEFAULT_GLOBAL_SHORTCUT,
      cameraStreamURLs: {},
    },
    hasLegacyCredentials: false,
  };
}

/** Writes settings without credentials; secrets belong to the Windows Credential Manager (#28). */
function writeSettingsForStorage(settings: PersistedSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettingsForStorage(settings)));
  } catch {
    // ignore storage quota errors
  }
}

/** Removes secrets from every settings copy, including the pre-1.0 legacy key. */
function stripCredentialFieldsFromStoredCopies(): void {
  for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify(sanitizeSettingsForStorage(parsed)));
    } catch {
      // ignore corrupt copies
    }
  }
}

function parseSingleElement(html: string): Element | null {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function hasMatchingDomShape(current: Node, desired: Node): boolean {
  if (current.nodeType !== desired.nodeType) return false;
  if (current.nodeType === 3) return true;
  if (current.nodeType !== 1) return current.isEqualNode(desired);
  const currentElement = current as Element;
  const desiredElement = desired as Element;
  if (currentElement.tagName !== desiredElement.tagName) return false;
  const currentChildren = Array.from(current.childNodes);
  const desiredChildren = Array.from(desired.childNodes);
  if (currentChildren.length !== desiredChildren.length) return false;
  return currentChildren.every((child, index) => hasMatchingDomShape(child, desiredChildren[index]!));
}

/** Updates an unchanged DOM tree in place so focused controls and their listeners survive. */
function morphMatchingDom(current: Node, desired: Node): void {
  if (current.nodeType === 3) {
    if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
    return;
  }
  if (current.nodeType !== 1) return;
  const currentElement = current as Element;
  const desiredElement = desired as Element;
  for (const attr of Array.from(currentElement.attributes)) {
    if (!desiredElement.hasAttribute(attr.name)) currentElement.removeAttribute(attr.name);
  }
  for (const attr of Array.from(desiredElement.attributes)) {
    if (currentElement.getAttribute(attr.name) !== attr.value) {
      currentElement.setAttribute(attr.name, attr.value);
    }
  }
  if (currentElement.tagName === "INPUT") {
    const currentInput = currentElement as HTMLInputElement;
    const desiredInput = desiredElement as HTMLInputElement;
    currentInput.value = desiredInput.value;
    currentInput.checked = desiredInput.checked;
  }
  const currentChildren = Array.from(current.childNodes);
  const desiredChildren = Array.from(desired.childNodes);
  currentChildren.forEach((child, index) => morphMatchingDom(child, desiredChildren[index]!));
}

function inputKeepsDraft(input: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (input.tagName === "TEXTAREA") return true;
  return !["button", "checkbox", "color", "file", "radio", "range", "reset", "submit"].includes(
    (input as HTMLInputElement).type,
  );
}

export class MenuMijiaWindowsApp {
  private readonly loadedSettings: LoadedSettings = loadSettings();
  private settings: PersistedSettings = this.loadedSettings.settings;
  private readonly credentialVault = new CredentialVault();
  private lastSubmittedEndpoints: string | null = null;
  // Assigned in the constructor, after the interface language is resolved: the demo home is
  // generated per language (#52), so a field initializer would freeze the module default.
  private devices: SmartDevice[];
  private scenes: HomeScene[];
  private environmentReadings: EnvironmentReading[] = [];
  private selectedRoom = "全部";
  private expandedDeviceId: string | null = null;
  private deviceSearch = "";
  private isDeviceSearchOpen = false;
  private activeSheet: "none" | "onboarding" | "settings" = "none";
  private onboardingStep = 0;
  private replyBanner: ReplyBannerState | null = null;
  private haConnectionError: string | null = null;
  /** A command waiting for the user to allow sending it to a cloud AI service (#20). */
  private panelResize: {
    pointerId: number;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    width: number;
    height: number;
    moved: boolean;
  } | null = null;
  private resizeFrame: number | undefined;
  private isSyncingCloud = false;
  private syncGeneration = 0;
  private lastCloudRefreshAt: number | null = null;
  private localControlRevision = 0;
  private sourceRevision = 0;
  /** A silent cloud result that is waiting for the user to finish interacting. */
  private pendingCloudRender = false;
  private endpointSubmission: Promise<unknown> = Promise.resolve();
  private pointerIsDown = false;
  private lastUndoAction: UndoAction | null = null;
  private qrTicket: QRLoginTicket | null = null;
  private qrStatusText = t("点击下方按钮获取安全二维码，用手机「米家 App → 扫一扫」即可同步真实全屋设备。");
  private isPollingQR = false;
  /** Latest GitHub release found by the daily check (#39); shown in settings and the tray menu. */
  private activeLiveCameraId: string | null = null;
  /**
   * The camera frees a used P2P session on its own schedule (measured: a fresh
   * session streams fine, but one that carried video needs well over a minute
   * before it can be re-negotiated). Closing the live modal therefore only
   * HIDES it and keeps the whole chain hot; full teardown happens when the
   * panel closes, the device errors, or after this long with nobody watching.
   */
  private liveCameraHidden = false;
  private liveCameraKeepAliveTimer: number | null = null;
  private static readonly CAMERA_KEEP_ALIVE_MS = 120_000;
  /** Tests pin this short to watch the teardown without waiting two minutes. */
  cameraKeepAliveMs = MenuMijiaWindowsApp.CAMERA_KEEP_ALIVE_MS;
  private liveCameraStreamURL: string | null = null;
  private liveCameraLoading = false;
  private liveCameraError: string | null = null;
  private liveCameraShowingURLInput = false;
  private cameraStreamURLs: Record<string, string> = { ...(this.settings.cameraStreamURLs ?? {}) };
  /** The live picture arrives as MJPEG frames in a persistent `<img>`, which never restarts on re-render. */
  private liveCameraMode: "mjpeg" | null = null;
  private liveCameraImgEl: HTMLImageElement | null = null;
  private liveCameraToken = 0;
  private readonly pendingCameraReleases = new Map<string, Promise<void>>();
  private readonly transport: HttpTransport = createTransport();
  private readonly specResolver: MiotSpecResolver;

  // Personalisation / layout editing state (see panelPrefs.ts).
  private homes: HomeOption[] = [];
  private isHomeMenuOpen = false;
  private isEditingLayout = false;
  private draggingId: string | null = null;
  private dragPointer: { x: number; y: number; grabX: number; grabY: number } | null = null;
  private lastSwap: { slot: string; at: number } | null = null;
  private ctxMenu: { x: number; y: number; deviceId?: string; groupId?: string } | null = null;
  private prompt: { kind: "newGroup"; deviceId: string } | { kind: "renameGroup"; groupId: string } | { kind: "renameDevice"; deviceId: string } | null = null;
  private animateEntrance = false;
  private poppedDeviceId: string | null = null;
  private dimPreview: { id: string; percent: number } | null = null;
  private suppressNextClick = false;
  private isRecordingHotkey = false;
  private hotkeyNeedsHint = false;
  private hotkeyRegistrationError: string | null = null;

  constructor(private readonly root: HTMLElement) {
    this.specResolver = new MiotSpecResolver(
      this.transport,
      undefined,
      this.settings.cachedModelTypes,
    );

    this.applyInterfaceLanguage();
    this.applyTemperatureSetting();
    const haCache = this.settings.cachedHAHome?.identity === homeAssistantIdentity(this.settings.haBaseURL, this.settings.haToken) ? this.settings.cachedHAHome.home : null;
    this.devices = this.settings.connectionMode === "xiaomiCloud"
      ? structuredClone(this.settings.cachedXiaomiDevices)
      : this.settings.connectionMode === "homeAssistant" ? structuredClone(haCache?.devices ?? []) : demoDevices();
    this.scenes = this.settings.connectionMode === "homeAssistant" ? structuredClone(haCache?.scenes ?? []) : this.settings.connectionMode === "demo" ? demoScenes() : [];
    this.environmentReadings = this.settings.connectionMode === "homeAssistant" ? structuredClone(haCache?.environmentReadings ?? []) : [];
    this.initializeCredentials();
    this.submitServiceEndpoints();

    if (!this.settings.hasCompletedOnboarding && !this.settings.miSession) {
      this.activeSheet = "onboarding";
    }

    this.bindGlobalKeys();
    this.bindLayoutGestures();
    this.bindOpenAnimation();
    this.bindPanelResize();
    this.applyPanelSize();
    void this.applyGlobalHotkey();
    this.startTimerLoop();
    this.render();

    if (this.settings.connectionMode === "xiaomiCloud" && this.settings.miSession) {
      void this.refreshDevices();
    }

  }

  /**
   * First run after this version: move the plaintext copy into the Windows Credential
   * Manager, then rewrite localStorage without secrets (#28). Later runs read only the
   * credential store, so an upgrade needs no QR login again.
   */
  private initializeCredentials(): void {
    if (this.loadedSettings.hasLegacyCredentials) {
      // Rewrite the plaintext copy first so a credential-manager failure can never
      // leave tokens in localStorage. The in-memory settings keep the login alive.
      writeSettingsForStorage(this.settings);
      stripCredentialFieldsFromStoredCopies();
      void this.persistCredentials();
      return;
    }
    // A stale pre-1.0 copy can still hold secrets even when the v2 copy is clean (#28).
    stripCredentialFieldsFromStoredCopies();
    void this.hydrateCredentials();
  }

  private async hydrateCredentials(): Promise<void> {
    try {
      const credentials = await this.credentialVault.load();
      if (!hasCredentials(credentials)) return;
      const current = credentialsFromSettings(this.settings);
      if (!current.miSession && credentials.miSession) this.settings.miSession = credentials.miSession;
      if (current.haToken === "" && credentials.haToken !== "") this.settings.haToken = credentials.haToken;
      if (current.assistantApiKey === "" && credentials.assistantApiKey !== "") {
        this.settings.openRouterApiKey = credentials.assistantApiKey;
      }
      if (this.settings.miSession) {
        this.settings.hasCompletedOnboarding = true;
        this.settings.miCloudRegion = normalizeMiCloudRegion(this.settings.miSession.region);
        if (this.activeSheet === "onboarding") this.activeSheet = "none";
      }
      this.submitServiceEndpoints();
      writeSettingsForStorage(this.settings);
      if (this.settings.connectionMode === "xiaomiCloud" && this.settings.miSession) {
        void this.refreshDevices(true);
      }
      if (this.settings.connectionMode === "homeAssistant") {
        const cache = this.settings.cachedHAHome;
        if (cache?.identity === homeAssistantIdentity(this.settings.haBaseURL, this.settings.haToken)) {
          this.devices = structuredClone(cache.home.devices);
          this.scenes = structuredClone(cache.home.scenes);
          this.environmentReadings = structuredClone(cache.home.environmentReadings);
        }
      }
      this.render();
      if (this.settings.connectionMode === "homeAssistant") void this.refreshHADevices();
    } catch {
      if (this.settings.connectionMode === "homeAssistant") {
        this.haConnectionError = "Home Assistant credentials could not be loaded. Check Windows Credential Manager.";
        this.render();
      }
    }
  }

  private async persistCredentials(): Promise<void> {
    try {
      await this.credentialVault.persist(credentialsFromSettings(this.settings));
    } catch {
      // The credential manager refused the write; never fall back to plaintext storage.
    }
  }

  private saveSettings(forceSubmitEndpoints = false): void {
    writeSettingsForStorage(this.settings);
    this.submitServiceEndpoints(forceSubmitEndpoints);
    void this.persistCredentials();
  }

  /** OS-preferred languages, read from the WebView's `window.navigator` (#52). */
  private static osLanguages(): string[] {
    const languages = window.navigator.languages;
    if (Array.isArray(languages) && languages.length > 0) return [...languages];
    return window.navigator.language ? [window.navigator.language] : [];
  }

  /** Picks the UI language from the saved preference plus the OS languages (#52). */
  private applyInterfaceLanguage(): void {
    setLanguage(resolveLanguage(this.settings.interfaceLanguage, MenuMijiaWindowsApp.osLanguages()));
  }

  /** Resolves °C/°F from the saved preference plus the OS region; core values stay Celsius (#52). */
  private applyTemperatureSetting(): void {
    const locale = MenuMijiaWindowsApp.osLanguages()[0] ?? "en";
    applyTemperatureUnit(locale, this.settings.temperatureUnit);
  }

  private submitServiceEndpoints(force = false): void {
    const haUrl = this.settings.haBaseURL.trim();
    if (!force && haUrl === this.lastSubmittedEndpoints) return;
    this.lastSubmittedEndpoints = haUrl;
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;
    this.endpointSubmission = invoke("set_service_endpoints", { haUrl }).catch(() => undefined);
  }

  private openSettingsSheet(): void {
    this.activeSheet = "settings";
    invokeTauriVoid("set_pin_popover", { pin: true });
    this.render();
  }

  private async applyGlobalHotkey(): Promise<void> {
    const enabled = this.settings.enableGlobalHotkey;
    const shortcut = normalizeGlobalShortcut(this.settings.globalHotkey);
    this.settings.globalHotkey = shortcut;
    if (!enabled) {
      this.hotkeyRegistrationError = null;
    }
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) {
      this.hotkeyRegistrationError = null;
      return;
    }
    try {
      await invoke("set_global_shortcut", { enabled, shortcut });
      this.hotkeyRegistrationError = null;
    } catch {
      this.hotkeyRegistrationError = enabled ? t("这个组合已被其他应用占用，换一个再试。") : null;
    }
    if (this.activeSheet === "settings") {
      this.render();
    }
  }

  private bindGlobalKeys(): void {
    window.addEventListener("keydown", (e) => {
      if (this.isRecordingHotkey) {
        e.preventDefault();
        e.stopPropagation();
        const outcome = recordShortcutFromKeyEvent(e);
        if (outcome.kind === "cancel") {
          this.isRecordingHotkey = false;
          this.hotkeyNeedsHint = false;
          this.render();
        } else if (outcome.kind === "invalid") {
          this.hotkeyNeedsHint = true;
          this.render();
        } else if (outcome.kind === "recorded") {
          this.isRecordingHotkey = false;
          this.hotkeyNeedsHint = false;
          this.settings.globalHotkey = outcome.shortcut;
          this.saveSettings();
          void this.applyGlobalHotkey();
          this.render();
        }
        return;
      }

      if (e.isComposing) return;
      if (e.key === "Escape") {
        if (this.activeLiveCameraId !== null) {
          this.hideCameraLiveView();
          return;
        }
        if (this.activeSheet !== "none") {
          this.activeSheet = "none";
          this.isRecordingHotkey = false;
          this.hotkeyNeedsHint = false;
          invokeTauriVoid("set_pin_popover", { pin: false });
          this.render();
        } else if (this.isDeviceSearchOpen) {
          e.preventDefault();
          this.setDeviceSearchOpen(false);
        } else {
          invokeTauriVoid("hide_panel");
        }
      } else if ((e.ctrlKey && e.key.toLowerCase() === "f") ||
                 (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? ""))) {
        if (this.activeSheet !== "none" || this.activeLiveCameraId !== null || this.prompt) return;
        e.preventDefault();
        this.setDeviceSearchOpen(true);
      }
    });
  }

  private startTimerLoop(): void {
    window.setInterval(() => {
      if (this.pendingCloudRender && !this.hasBlockingPanelInteraction()) {
        this.render();
      }

      const now = Date.now();
      let changed = false;

      if (this.lastUndoAction && this.lastUndoAction.expiresAtMs <= now) {
        this.lastUndoAction = null;
        changed = true;
      }

      if (changed) {
        this.render();
      }

      if (
        (this.settings.connectionMode === "homeAssistant" || this.settings.connectionMode === "xiaomiCloud" && this.settings.miSession) &&
        this.activeSheet === "none" &&
        !this.isSyncingCloud &&
        !this.isPollingQR &&
        cloudRefreshDue(now, this.lastCloudRefreshAt, this.isPanelVisible())
      ) {
        void this.refreshDevices(true);
      }
    }, 1000);
  }

  /** The tray popover hides when it loses focus, so focus means it is on screen. */
  private isPanelVisible(): boolean {
    return document.visibilityState !== "hidden" && document.hasFocus();
  }

  /** Background refreshes must not rebuild the panel while the user is mid-action. */
  private hasBlockingPanelInteraction(): boolean {
    return (
      this.activeSheet !== "none" ||
      this.pointerIsDown ||
      this.draggingId !== null ||
      this.isEditingLayout ||
      this.isHomeMenuOpen ||
      this.ctxMenu !== null ||
      this.prompt !== null
    );
  }

  /** Applies a background result only when it cannot clear focus or cancel a pointer gesture. */
  private queueBackgroundRender(): void {
    if (this.hasBlockingPanelInteraction()) {
      this.pendingCloudRender = true;
      return;
    }
    this.render();
  }

  private get rooms(): string[] {
    const unique = Array.from(new Set(this.devices.map((d) => d.roomName)));
    return ["全部", ...unique];
  }

  private get roomDevices(): SmartDevice[] {
    const devices = this.visibleDevices;
    return this.selectedRoom === "全部"
      ? devices
      : devices.filter((d) => d.roomName === this.selectedRoom);
  }

  private get hiddenDeviceIds(): readonly string[] {
    const ids = this.layout.hiddenDeviceIds?.[this.settings.connectionMode];
    return Array.isArray(ids) ? ids : [];
  }

  private get visibleDevices(): SmartDevice[] {
    const hidden = new Set(this.hiddenDeviceIds);
    return this.devices.filter((device) => !hidden.has(device.id) &&
      (this.layout.hideOfflineDevices !== true || device.isOnline));
  }

  private setDeviceHidden(id: string, hidden: boolean): void {
    const ids = new Set(this.hiddenDeviceIds);
    if (hidden) ids.add(id);
    else ids.delete(id);
    this.layout.hiddenDeviceIds = {
      ...this.layout.hiddenDeviceIds,
      [this.settings.connectionMode]: [...ids],
    };
    if (hidden && this.expandedDeviceId === id) this.expandedDeviceId = null;
    this.ctxMenu = null;
    this.saveLayout();
    this.render();
  }

  private get filteredDevices(): SmartDevice[] {
    const terms = this.deviceSearch.trim().normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
    const devices = this.roomDevices;
    if (terms.length === 0) return devices;
    return devices.filter((device) => {
      const fields = [device.name, this.layout.aliases[device.id] ?? "", device.roomName];
      const searchable = fields.flatMap((field) => {
        const text = field.normalize("NFKC").toLowerCase();
        const syllables = pinyin(text, { toneType: "none", type: "array" });
        return [text, syllables.join(""), syllables.map((syllable) => syllable[0]).join("")];
      });
      return terms.every((term) => searchable.some((value) => value.includes(term)));
    });
  }

  private setDeviceSearch(query: string): void {
    if (query === this.deviceSearch) return;
    this.deviceSearch = query;
    const search = this.root.querySelector<HTMLInputElement>("#device-search");
    if (search && search.value !== query) search.value = query;
    this.expandedDeviceId = null;
    this.render();
    const area = this.root.querySelector(".cc-scroll-area");
    if (area) area.scrollTop = 0;
  }

  private setDeviceSearchOpen(open: boolean): void {
    if (open !== this.isDeviceSearchOpen) {
      this.isDeviceSearchOpen = open;
      if (!open && this.deviceSearch) this.setDeviceSearch("");
      else this.render();
    }
    this.root.querySelector<HTMLElement>(open ? "#device-search" : "#btn-device-search")?.focus();
  }

  private get activeDeviceCount(): number {
    return this.devices.filter((d) => isDeviceActiveOn(d)).length;
  }

  private get onlineDeviceCount(): number {
    return this.devices.filter((d) => d.isOnline).length;
  }

  private get totalPowerWatts(): number {
    let watts = 0;
    for (const d of this.devices) {
      if (d.kind.kind === "plug" && d.kind.powerWatts && d.kind.powerWatts > 0) {
        watts += d.kind.powerWatts;
      }
    }
    return watts;
  }

  private get computedEnvironmentReadings(): EnvironmentReading[] {
    const devices = this.visibleDevices;
    if (this.environmentReadings.length > 0) {
      const priorityById = new Map(
        devices.map((d) => [d.id, environmentReadingPriority(d.kind)]),
      );
      return this.environmentReadings.filter((reading) => priorityById.has(reading.id)).sort(
        (a, b) => (priorityById.get(a.id) ?? 0) - (priorityById.get(b.id) ?? 0),
      );
    }
    const out: Array<{ reading: EnvironmentReading; priority: number; index: number }> = [];
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i]!;
      const reading = deviceEnvironmentReading(d);
      if (reading) {
        out.push({
          reading,
          priority: environmentReadingPriority(d.kind),
          index: i,
        });
      }
    }
    out.sort((a, b) => a.priority - b.priority || a.index - b.index);
    return out.map((item) => item.reading);
  }

  private async refreshDevices(silent = false): Promise<void> {
    if (this.settings.connectionMode === "homeAssistant") return this.refreshHADevices(silent);
    if (!this.settings.miSession || this.settings.connectionMode !== "xiaomiCloud" || this.isSyncingCloud) return;
    const session = this.settings.miSession;
    const previousPresentation = this.cloudPresentationFingerprint();
    const previousStructure = this.cloudPanelStructureFingerprint();
    const stateRevisionAtStart = this.localControlRevision;
    const syncGen = ++this.syncGeneration;
    let presentationChanged = false;
    let clearedSyncError = false;
    this.isSyncingCloud = true;
    this.lastCloudRefreshAt = Date.now();
    if (!silent) {
      this.render();
    }

    try {
      const client = new MiCloudClient(session, this.transport);
      const [allDevices, allRooms] = await Promise.all([
        client.deviceList(),
        client.homeRooms().catch(() => []),
      ]);
      const nextHomes = homeOptions(allRooms);
      if (this.cloudSnapshotIsStale(session, stateRevisionAtStart)) return;
      this.homes = applyOrder(this.homes.map((home) => home.id), nextHomes);
      const { devices: rawDevices, rooms } = this.filterBySelectedHome(allDevices, allRooms);

      // Stage 1: Instant synthesis with cached/fallback specs so user sees their real devices immediately
      const stage1Specs = this.specResolver.exportCachedSpecs();
      const stage1Home = MiotSynthesizer.synthesize(
        rawDevices,
        rooms,
        stage1Specs,
        new Map<string, unknown>(),
      );
      if (stage1Home.devices.length > 0 && this.devices.length === 0) {
        this.devices = stage1Home.devices;
        presentationChanged = true;
        this.render();
      }

      // Stage 2: Resolve exact MIoT specs + fetch live device properties
      const specs = await this.specResolver.resolveForDevices(rawDevices);
      const propKeys: MiotPropKey[] = [];
      for (const dev of rawDevices) {
        const spec = specs[dev.model];
        if (spec) {
          propKeys.push(...MiotSynthesizer.requiredProps(dev, spec));
        }
      }

      const values =
        propKeys.length > 0
          ? await client.getProps(propKeys).catch(() => new Map<string, unknown>())
          : new Map<string, unknown>();

      const home = MiotSynthesizer.synthesize(rawDevices, rooms, specs, values);
      if (this.cloudSnapshotIsStale(session, stateRevisionAtStart)) return;
      // Cloud list order is not a layout preference. Keep known devices in their
      // displayed order, use fresh values, drop removed ids and append new ones.
      this.devices = applyOrder(this.devices.map((device) => device.id), home.devices);
      const readingPriorityById = new Map(
        home.devices.map((device) => [device.id, environmentReadingPriority(device.kind)]),
      );
      this.environmentReadings = applyOrder(
        this.environmentReadings.map((reading) => reading.id),
        home.environmentReadings,
      ).sort(
        (a, b) => (readingPriorityById.get(a.id) ?? 0) - (readingPriorityById.get(b.id) ?? 0),
      );
      presentationChanged =
        presentationChanged || this.cloudPresentationFingerprint() !== previousPresentation;

      this.settings.cachedXiaomiDevices = this.devices;
      const knownModelTypes = this.specResolver.exportKnownModelTypes(
        rawDevices.map((d) => d.model),
      );
      const cacheChanged =
        JSON.stringify(knownModelTypes) !== JSON.stringify(this.settings.cachedModelTypes);
      this.settings.cachedModelTypes = knownModelTypes;
      if (presentationChanged || cacheChanged) {
        this.saveSettings();
      }

      if (this.replyBanner?.isCloudSyncError) {
        this.replyBanner = null;
        clearedSyncError = true;
      }
    } catch (err) {
      if (!silent && this.syncGeneration === syncGen && !this.cloudSnapshotIsStale(session, stateRevisionAtStart)) {
        const msg = err instanceof Error ? err.message : String(err);
        this.replyBanner = {
          text: t("米家云同步失败：{message}", { message: msg }),
          source: t("连接异常"),
          isError: true,
          isCloudSyncError: true,
        };
      }
    } finally {
      if (this.syncGeneration === syncGen) {
        this.isSyncingCloud = false;
        if (!silent) {
          this.render();
        } else if (clearedSyncError) {
          this.queueBackgroundRender();
        } else if (presentationChanged) {
          if (
            this.cloudPanelStructureFingerprint() !== previousStructure ||
            !this.patchCloudPresentation()
          ) {
            this.queueBackgroundRender();
          }
        }
      }
    }
  }

  private async refreshHADevices(silent = false): Promise<void> {
    if (this.settings.connectionMode !== "homeAssistant" || this.isSyncingCloud) return;
    const endpoint = this.settings.haBaseURL;
    const token = this.settings.haToken;
    const revision = this.localControlRevision;
    const syncGen = ++this.syncGeneration;
    const previousPresentation = this.cloudPresentationFingerprint();
    const previousStructure = this.cloudPanelStructureFingerprint();
    let failed = false;
    let shouldUpdateView = false;
    this.isSyncingCloud = true;
    this.lastCloudRefreshAt = Date.now();
    if (!silent && this.devices.length === 0) this.render();
    try {
      await this.endpointSubmission;
      const home = await new HomeAssistantClient(endpoint, token).snapshot();
      const identity = homeAssistantIdentity(endpoint, token);
      if (!identity) throw new Error("Invalid Home Assistant URL");
      if (this.settings.connectionMode !== "homeAssistant" || this.settings.haBaseURL !== endpoint || this.settings.haToken !== token || this.localControlRevision !== revision || this.syncGeneration !== syncGen) return;
      this.devices = applyOrder(this.devices.map((device) => device.id), home.devices);
      this.scenes = home.scenes;
      const readingPriorityById = new Map(
        home.devices.map((device) => [device.id, environmentReadingPriority(device.kind)]),
      );
      this.environmentReadings = applyOrder(
        this.environmentReadings.map((reading) => reading.id),
        home.environmentReadings,
      ).sort(
        (a, b) => (readingPriorityById.get(a.id) ?? 0) - (readingPriorityById.get(b.id) ?? 0),
      );
      const hadValidCache = this.settings.cachedHAHome?.identity === identity;
      const presentationChanged =
        this.cloudPresentationFingerprint() !== previousPresentation || this.haConnectionError !== null;
      this.settings.cachedHAHome = {identity,home:{...home,devices:this.devices,environmentReadings:this.environmentReadings}};
      if (this.haConnectionError !== null) failed = true;
      this.haConnectionError = null;
      if (presentationChanged || !hadValidCache) this.saveSettings();
      shouldUpdateView = !silent || presentationChanged;
    } catch (error) {
      if (this.settings.connectionMode !== "homeAssistant" || this.settings.haBaseURL !== endpoint || this.settings.haToken !== token || this.localControlRevision !== revision || this.syncGeneration !== syncGen) return;
      failed = true;
      shouldUpdateView = true;
      this.haConnectionError = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.syncGeneration === syncGen) {
        this.isSyncingCloud = false;
        if (shouldUpdateView) {
          if (failed || this.devices.length === 0 || this.cloudPanelStructureFingerprint() !== previousStructure || !this.patchCloudPresentation()) this.queueBackgroundRender();
        }
      }
    }
  }

  /** Cloud state that affects the rendered panel; polling a matching snapshot is a visual no-op. */
  private cloudPresentationFingerprint(): string {
    return JSON.stringify({
      homes: this.homes,
      devices: this.devices,
      scenes: this.scenes,
      environmentReadings: this.environmentReadings,
    });
  }

  private cloudSnapshotIsStale(session: MiSession, revision: number): boolean {
    return (
      this.settings.connectionMode !== "xiaomiCloud" ||
      this.settings.miSession !== session ||
      this.localControlRevision !== revision
    );
  }

  private cloudPanelStructureFingerprint(): string {
    return JSON.stringify({
      homes: this.homes,
      scenes: this.scenes,
      allOffTargets: this.settings.connectionMode === "homeAssistant" ? null : this.allOffTargets.map((device) => device.id),
      devices: this.devices.map((device) => {
        const kind = device.kind;
        const capabilities =
          kind.kind === "light"
            ? [kind.availableEffects, kind.minKelvin, kind.maxKelvin]
            : kind.kind === "climate"
              ? [kind.availableModes, kind.availableFanModes, kind.minTemp, kind.maxTemp, kind.step]
              : kind.kind === "fan"
                ? [kind.availablePresetModes]
                : kind.kind === "vacuum"
                  ? [kind.availableModes]
                  : kind.kind === "camera"
                    ? [kind.availableNightShots, kind.motionDetectionEntityId]
                    : [];
        return {
          id: device.id,
          name: device.name,
          roomId: device.roomId,
          roomName: device.roomName,
          model: device.model,
          online: this.layout.hideOfflineDevices === true ? device.isOnline : undefined,
          category: kind.kind,
          capabilities,
          sensorShape:
            kind.kind === "sensor"
              ? [kind.temperature !== null, kind.humidity !== null, kind.battery !== null]
              : null,
        };
      }),
    });
  }

  private patchCloudPresentation(): boolean {
    if (
      this.isEditingLayout ||
      this.activeSheet !== "none" ||
      this.pointerIsDown ||
      this.draggingId !== null
    ) {
      return false;
    }

    const isAll = this.selectedRoom === "全部";
    const ordered = withAliases(this.layout, applyOrder(this.layout.order, this.filteredDevices));
    const sections = pageSections(this.layout, ordered, isAll);
    const bento = this.skin === "bento" && this.settings.isCompactGridMode;
    const tilePatches: Array<{ current: HTMLElement; desired: Element }> = [];
    let index = 0;
    for (const section of sections) {
      if (this.layout.collapsed.includes(scopedKey(this.pageKey, section.id))) continue;
      const spanMap = spans(
        section.devices,
        (device) => (this.expandedDeviceId === device.id ? "full" : this.tileSize(device)),
        bento,
      );
      for (const device of section.devices) {
        const current = Array.from(
          this.root.querySelectorAll<HTMLElement>("[data-tile-id]"),
        ).find((element) => element.dataset.tileId === device.id);
        const desired = parseSingleElement(
          this.renderDeviceTile(device, spanMap.get(device.id) ?? 6, index++),
        );
        if (!current || !desired || !hasMatchingDomShape(current, desired)) return false;
        tilePatches.push({ current, desired });
      }
    }
    for (const patch of tilePatches) morphMatchingDom(patch.current, patch.desired);
    if (this.settings.connectionMode === "homeAssistant") {
      const current = this.root.querySelector<HTMLElement>("#btn-all-off");
      const desired = parseSingleElement(this.renderAllOffControl());
      if (current && desired) {
        morphMatchingDom(current, desired);
      } else if (current) {
        current.remove();
      } else if (desired) {
        this.root.querySelector("#btn-device-search")?.before(desired);
        this.bindAllOffControl();
      }
    }

    const envHTML = this.renderEnvironmentStrip();
    const currentEnv = this.root.querySelector<HTMLElement>(".cc-env-strip");
    if (currentEnv) {
      const desiredEnv = parseSingleElement(envHTML);
      if (!desiredEnv) {
        currentEnv.remove();
      } else if (hasMatchingDomShape(currentEnv, desiredEnv)) {
        morphMatchingDom(currentEnv, desiredEnv);
      } else {
        currentEnv.replaceWith(desiredEnv);
      }
    } else if (envHTML) {
      this.root.querySelector(".cc-header-top")?.insertAdjacentHTML("afterend", envHTML);
    }

    const subtitle = this.root.querySelector<HTMLElement>(".cc-subtitle");
    if (subtitle) subtitle.textContent = this.statusSummaryText;
    this.root
      .querySelector<HTMLElement>(".cc-home-badge")
      ?.classList.toggle("is-active", this.activeDeviceCount > 0);
    const footerLabel = this.root.querySelector<HTMLElement>(".cc-footer-label");
    if (footerLabel) {
      footerLabel.textContent =
        this.settings.connectionMode === "xiaomiCloud" && this.settings.miSession
          ? t("米家账号 {user} · {count} 台设备", {
              user: maskedMiUserId(this.settings.miSession.userId),
              count: this.devices.length,
            })
          : this.settings.connectionMode === "homeAssistant" ? `Home Assistant · ${this.devices.length}` : t("演示模式 · 未连接米家云");
    }
    return true;
  }

  /** Narrows cloud records and rooms to the selected Mi Home; split keys bring their parent panel along. */
  private filterBySelectedHome<D extends { readonly did: string; readonly splitParentDid?: string | null }, R extends { readonly homeId?: string; readonly dids: readonly string[] }>(
    devices: readonly D[],
    rooms: readonly R[],
  ): { devices: D[]; rooms: R[] } {
    const selected = this.settings.selectedHomeId;
    if (!selected || !this.homes.some((h) => h.id === selected)) return { devices: [...devices], rooms: [...rooms] };
    const homeRooms = rooms.filter((r) => r.homeId === selected);
    const dids = new Set(homeRooms.flatMap((r) => r.dids));
    const kept = devices.filter((d) => dids.has(d.did) || (d.splitParentDid ? dids.has(d.splitParentDid) : false));
    const parents = new Set(kept.map((d) => d.splitParentDid).filter((x): x is string => !!x));
    const withParents = devices.filter((d) => kept.includes(d) || parents.has(d.did));
    return { devices: withParents, rooms: homeRooms };
  }

  private selectHome(id: string | null): void {
    this.settings.selectedHomeId = id;
    this.isHomeMenuOpen = false;
    this.selectedRoom = "全部";
    this.invalidateSourceControl();
    this.saveSettings();
    this.render();
    void this.refreshDevices(false);
  }

  private get homeTitle(): string {
    const h = this.homes.find((x) => x.id === this.settings.selectedHomeId);
    return h ? h.name : this.homes.length > 1 ? t("全部家庭") : t("我的米家");
  }

  /** Devices 全关 would switch off: on screen (current room), on, and taking part (#23). */
  private get allOffTargets(): SmartDevice[] {
    return allOffTargets(this.roomDevices, this.settings.allOffOverrides);
  }

  private renderAllOffControl(): string {
    if (this.isEditingLayout) return `<button class="cc-all-off-pill is-done" id="btn-done-editing" aria-label="${t("完成布局编辑")}">${t("完成")}</button>`;
    const count = this.allOffTargets.length;
    if (count === 0) return "";
    return `<button class="cc-all-off-pill is-hold" id="btn-all-off" title="${t("按住 0.6 秒关闭这 {count} 台（插座、扫地机默认不参与，可在设置里调整）", { count })}" aria-label="${t("全关，关闭 {count} 台设备，按住 0.6 秒确认", { count })}">
      <span class="cc-hold-fill"></span>
      ${SF_ICONS.power}
      <span>${this.selectedRoom === "全部" ? t("全关") : t("全关·{room}", { room: this.escapeHtml(this.selectedRoom) })} (${count})</span>
    </button>`;
  }

  private bindAllOffControl(): void {
    const allOff = this.root.querySelector<HTMLElement>("#btn-all-off");
    if (!allOff) return;
    let holdTimer: number | undefined;
    let fired = false;
    allOff.addEventListener("pointerdown", () => {
      fired = false;
      allOff.classList.add("is-holding");
      holdTimer = window.setTimeout(() => {
        fired = true;
        allOff.classList.remove("is-holding");
        void this.turnAllOff();
      }, 600);
    });
    const cancel = () => {
      window.clearTimeout(holdTimer);
      allOff.classList.remove("is-holding");
    };
    allOff.addEventListener("pointerup", () => {
      cancel();
      if (!fired) {
        this.replyBanner = { text: t("按住 0.6 秒关闭这 {count} 台（插座、扫地机默认不参与）", { count: this.allOffTargets.length }), source: t("提示") };
        this.render();
      }
    });
    allOff.addEventListener("pointerleave", cancel);
  }

  private async turnAllOff(): Promise<void> {
    const targets = this.allOffTargets;
    if (targets.length === 0) return;
    const intents: DeviceIntent[] = targets.map((d) => ({
      targetId: d.id,
      operation: { kind: "power", isOn: false },
    }));
    await this.executeIntents(
      intents,
      t("已关闭 {count} 台开启中的设备", { count: targets.length }),
      t("一键全关"),
    );
  }

  private buildInverseCommand(dev: SmartDevice, command: DeviceCommand): DeviceCommand[] {
    const k = dev.kind;
    switch (command.kind) {
      case "setLightPower":
        return k.kind === "light" ? [{ kind: "setLightPower", entityId: k.entityId, isOn: k.isOn }] : [];
      case "setLightBrightness":
        return k.kind === "light" && k.brightnessPercent !== null ? [
          { kind: "setLightBrightness", entityId: k.entityId, percent: k.brightnessPercent },
          { kind: "setLightPower", entityId: k.entityId, isOn: k.isOn },
        ] : [];
      case "setLightColorTemp":
        return k.kind === "light" && k.colorTempKelvin !== null ? [
          { kind: "setLightColorTemp", entityId: k.entityId, kelvin: k.colorTempKelvin },
          ...(k.currentEffect !== null ? [{ kind: "setLightEffect" as const, entityId: k.entityId, effect: k.currentEffect }] : []),
          { kind: "setLightPower", entityId: k.entityId, isOn: k.isOn },
        ] : [];
      case "setLightEffect":
        if (k.kind !== "light") return [];
        if (k.currentEffect !== null) return [
          { kind: "setLightEffect", entityId: k.entityId, effect: k.currentEffect },
          { kind: "setLightPower", entityId: k.entityId, isOn: k.isOn },
        ];
        return k.colorTempKelvin !== null ? [
          { kind: "setLightColorTemp", entityId: k.entityId, kelvin: k.colorTempKelvin },
          { kind: "setLightPower", entityId: k.entityId, isOn: k.isOn },
        ] : [];
      case "setClimatePower":
      case "setClimateMode":
        return k.kind === "climate" ? [{ kind: "setClimateMode", entityId: k.entityId, hvacMode: k.isOn ? k.hvacMode : "off" }] : [];
      case "setClimateTemperature":
        return k.kind === "climate" ? [
          { kind: "setClimateTemperature", entityId: k.entityId, temperature: k.targetTemperature },
          { kind: "setClimatePower", entityId: k.entityId, isOn: k.isOn, resumeMode: k.hvacMode },
        ] : [];
      case "setClimateFanMode":
        return k.kind === "climate" && k.fanMode !== null ? [{ kind: "setClimateFanMode", entityId: k.entityId, fanMode: k.fanMode }] : [];
      case "setFanPower":
        return k.kind === "fan" ? [{ kind: "setFanPower", entityId: k.entityId, isOn: k.isOn }] : [];
      case "setFanPercentage":
        return k.kind === "fan" && k.percentage !== null ? [
          { kind: "setFanPercentage", entityId: k.entityId, percent: k.percentage },
          ...(k.presetMode !== null ? [{ kind: "setFanPresetMode" as const, entityId: k.entityId, presetMode: k.presetMode }] : []),
          { kind: "setFanPower", entityId: k.entityId, isOn: k.isOn },
        ] : [];
      case "setFanPresetMode":
        return k.kind === "fan" && k.presetMode !== null ? [
          { kind: "setFanPresetMode", entityId: k.entityId, presetMode: k.presetMode },
          { kind: "setFanPower", entityId: k.entityId, isOn: k.isOn },
        ] : [];
      case "setFanOscillating":
        return k.kind === "fan" && k.isOscillating !== null ? [
          { kind: "setFanOscillating", entityId: k.entityId, oscillating: k.isOscillating },
          { kind: "setFanPower", entityId: k.entityId, isOn: k.isOn },
        ] : [];
      case "setSwitch":
        if (k.kind === "plug") {
          return [{ kind: "setSwitch", entityId: command.entityId, isOn: command.entityId === k.childLockEntityId ? k.isChildLocked : k.isOn }];
        }
        if (k.kind === "camera") {
          const prevOn = command.entityId === k.motionDetectionEntityId ? Boolean(k.isMotionDetectionOn) : k.isOn;
          return [{ kind: "setSwitch", entityId: command.entityId, isOn: prevOn }];
        }
        return [];
      case "setSelectOption":
        if (k.kind === "camera" && k.nightShot !== null) {
          return [{ kind: "setSelectOption", entityId: command.entityId, option: k.nightShot }];
        }
        return [];
      case "vacuumAction":
      case "activateScene":
        return [];
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  private async executeIntents(
    intents: readonly DeviceIntent[],
    replyText: string,
    sourceLabel: string,
  ): Promise<boolean> {
    const sourceRevision = this.sourceRevision;
    const commands: Array<{ deviceId: string; command: DeviceCommand }> = [];
    for (const intent of intents) {
      if (intent.operation.kind === "activateScene") {
        const scene = this.scenes.find((s) => s.id === intent.targetId);
        if (scene) commands.push({ deviceId: scene.id, command: { kind: "activateScene", entityId: scene.entityId } });
        continue;
      }
      const dev = this.devices.find((d) => d.id === intent.targetId);
      if (!dev) continue;
      for (const command of IntentValidator.commandsForIntent(intent, dev)) {
        commands.push({ deviceId: dev.id, command });
      }
    }

    if (commands.length === 0) {
      this.replyBanner = { text: t("当前房间没有可执行此操作的设备"), source: t("提示") };
      this.render();
      return false;
    }

    const steps: UndoStep[] = [];
    let succeeded = 0;
    let canUndo = true;
    let failed = 0;
    let failureMessage = "";
    for (const { deviceId, command } of commands) {
      if (sourceRevision !== this.sourceRevision) return false;
      // Scenes have no device row and no inverse; they simply run and count as applied (#113).
      if (command.kind === "activateScene") {
        if (await this.applyCommand(command)) {
          succeeded += 1;
        } else {
          failed += 1;
          failureMessage = this.replyBanner?.text ?? "设备未响应";
        }
        continue;
      }
      const device = this.devices.find((d) => d.id === deviceId);
      if (!device) {
        failed += 1;
        failureMessage = t("设备列表已更新，请重新执行");
        continue;
      }
      const inverseCommands = this.buildInverseCommand(device, command);
      if (await this.applyCommand(command)) {
        succeeded += 1;
        canUndo = canUndo && inverseCommands.length > 0;
        steps.unshift({ deviceId, commands: inverseCommands });
      } else {
        failed += 1;
        failureMessage = this.replyBanner?.text ?? "设备未响应";
      }
    }
    if (sourceRevision !== this.sourceRevision) return false;
    if (succeeded > 0) {
      // Scene activations have no inverse: an undo action must exist only when at least one
      // device step is restorable, otherwise Undo would report success without doing anything
      // (Codex #116 re-review).
      this.lastUndoAction = canUndo && steps.length > 0 ? {
        summary: replyText,
        steps,
        expiresAtMs: Date.now() + 10 * 60 * 1000,
      } : null;
    }
    this.replyBanner = failed > 0
      ? { text: t("已执行 {ok} 项，{failed} 项失败。{message}", { ok: commands.length - failed, failed: failed, message: failureMessage }), source: t("控制失败"), isError: true }
      : { text: replyText, source: sourceLabel };
    this.render();
    return failed === 0;
  }

  private async executeSingleCommand(
    device: SmartDevice,
    command: DeviceCommand,
    summary: string,
  ): Promise<void> {
    const sourceRevision = this.sourceRevision;
    const inverseCommands = this.buildInverseCommand(device, command);
    if (!(await this.applyCommand(command))) return;
    if (sourceRevision !== this.sourceRevision) return;
    this.lastUndoAction = inverseCommands.length > 0 ? {
      summary,
      steps: [{ deviceId: device.id, commands: inverseCommands }],
      expiresAtMs: Date.now() + 10 * 60 * 1000,
    } : null;
    this.replyBanner = { text: summary, source: t("实时控制") };
    this.render();
  }

  private invalidateSourceControl(): void {
    this.sourceRevision += 1;
    this.syncGeneration += 1;
    this.isSyncingCloud = false;
    this.haConnectionError = null;
    this.lastUndoAction = null;
    this.replyBanner = null;
  }

  private async performUndo(): Promise<void> {
    if (!this.lastUndoAction || this.lastUndoAction.expiresAtMs <= Date.now()) {
      this.lastUndoAction = null;
      this.replyBanner = {
        text: t("没有可撤销的操作（仅支持 10 分钟内的操作撤销）"),
        source: t("撤销提示"),
      };
      this.render();
      return;
    }
    const action = this.lastUndoAction;
    const sourceRevision = this.sourceRevision;
    const failedSteps: UndoStep[] = [];
    const blockedDevices = new Set<string>();
    let failureMessage = "";
    for (const step of action.steps) {
      if (blockedDevices.has(step.deviceId)) {
        failedSteps.push(step);
        continue;
      }
      let failed = false;
      for (const command of step.commands) {
        if (sourceRevision !== this.sourceRevision) return;
        if (!(await this.applyCommand(command))) {
          failed = true;
          failureMessage = this.replyBanner?.text ?? "设备未响应";
        }
      }
      if (failed) {
        failedSteps.push(step);
        blockedDevices.add(step.deviceId);
      }
    }
    if (sourceRevision !== this.sourceRevision) return;
    this.lastUndoAction = failedSteps.length > 0
      ? { ...action, steps: failedSteps }
      : null;
    this.replyBanner = failedSteps.length > 0
      ? { text: t("撤销未完成，{count} 项待恢复。{message}", { count: failedSteps.length, message: failureMessage }), source: t("控制失败"), isError: true }
      : { text: t("已撤销：{summary}", { summary: action.summary }), source: t("已恢复") };
    this.render();
  }

  private async applyCommand(command: DeviceCommand): Promise<boolean> {
    const sourceRevision = this.sourceRevision;
    try {
      if (this.settings.connectionMode === "homeAssistant") command = homeAssistantCommand(command, this.devices);
      await this.dispatchCloudCommand(command);
    } catch (error) {
      if (sourceRevision !== this.sourceRevision) return false;
      this.replyBanner = {
        text: error instanceof Error ? error.message : String(error),
        source: t("控制失败"),
        isError: true,
      };
      this.render();
      return false;
    }
    if (sourceRevision !== this.sourceRevision) return false;
    this.localControlRevision += 1;
    for (const dev of this.devices) {
      const k = dev.kind;
      switch (command.kind) {
        case "setLightPower":
          if (k.kind === "light" && k.entityId === command.entityId) {
            k.isOn = command.isOn;
          }
          break;
        case "setLightBrightness":
          if (k.kind === "light" && k.entityId === command.entityId) {
            k.isOn = command.percent > 0;
            k.brightnessPercent = command.percent;
          }
          break;
        case "setLightColorTemp":
          if (k.kind === "light" && k.entityId === command.entityId) {
            k.isOn = true;
            k.colorTempKelvin = command.kelvin;
            k.currentEffect = null;
          }
          break;
        case "setLightEffect":
          if (k.kind === "light" && k.entityId === command.entityId) {
            k.isOn = true;
            k.currentEffect = command.effect;
          }
          break;
        case "setClimatePower":
          if (k.kind === "climate" && k.entityId === command.entityId) {
            k.isOn = command.isOn;
            k.hvacMode = command.isOn ? command.resumeMode : "off";
          }
          break;
        case "setClimateMode":
          if (k.kind === "climate" && k.entityId === command.entityId) {
            k.isOn = command.hvacMode !== "off";
            k.hvacMode = command.hvacMode;
          }
          break;
        case "setClimateTemperature":
          if (k.kind === "climate" && k.entityId === command.entityId) {
            if (this.settings.connectionMode !== "homeAssistant" || k.hvacMode !== "off") {
              k.isOn = true;
            }
            k.targetTemperature = command.temperature;
          }
          break;
        case "setClimateFanMode":
          if (k.kind === "climate" && k.entityId === command.entityId) {
            k.fanMode = command.fanMode;
          }
          break;
        case "setFanPower":
          if (k.kind === "fan" && k.entityId === command.entityId) {
            k.isOn = command.isOn;
          }
          break;
        case "setFanPercentage":
          if (k.kind === "fan" && k.entityId === command.entityId) {
            k.isOn = command.percent > 0;
            k.percentage = command.percent;
            const fav = k.availablePresetModes.find((m) => m.toLowerCase() === "favorite");
            if (fav) k.presetMode = fav;
          }
          break;
        case "setFanPresetMode":
          if (k.kind === "fan" && k.entityId === command.entityId) {
            k.isOn = true;
            k.presetMode = command.presetMode;
          }
          break;
        case "setFanOscillating":
          if (k.kind === "fan" && k.entityId === command.entityId) {
            k.isOn = true;
            k.isOscillating = command.oscillating;
          }
          break;
        case "setSwitch":
          if (k.kind === "plug" && k.switchEntityId === command.entityId) {
            k.isOn = command.isOn;
          } else if (k.kind === "camera") {
            if (k.entityId === command.entityId) {
              k.isOn = command.isOn;
              if (this.activeLiveCameraId === dev.id && !this.liveCameraHidden) {
                if (command.isOn) {
                  this.reconnectCameraLiveView();
                } else {
                  this.stopLiveTransport();
                  this.liveCameraLoading = false;
                }
              }
            } else if (k.motionDetectionEntityId === command.entityId) {
              k.isMotionDetectionOn = command.isOn;
            }
          }
          break;
        case "setSelectOption":
          if (k.kind === "camera" && k.entityId === command.entityId) {
            k.nightShot = command.option;
          }
          break;
        case "vacuumAction":
          if (k.kind === "vacuum" && k.entityId === command.entityId) {
            k.status =
              command.action === "start"
                ? "cleaning"
                : command.action === "pause"
                  ? "paused"
                  : "returning";
          }
          break;
        case "activateScene":
          break;
      }
    }

    return true;
  }

  private async dispatchCloudCommand(command: DeviceCommand): Promise<void> {
    const sourceRevision = this.sourceRevision;
    if (this.settings.connectionMode === "demo") return;
    if (this.settings.connectionMode === "homeAssistant") {
      const client = new HomeAssistantClient(this.settings.haBaseURL, this.settings.haToken);
      await this.endpointSubmission;
      if (sourceRevision !== this.sourceRevision) throw new Error("Connection source changed");
      return client.execute(command);
    }
    if (!this.settings.miSession) throw new Error(t("请先扫码登录米家"));
    const session = this.settings.miSession;
    const dev = this.devices.find((d) => {
      const k = d.kind;
      if (k.kind === "plug") return k.switchEntityId === command.entityId || k.childLockEntityId === command.entityId;
      if (k.kind === "camera") return k.entityId === command.entityId || k.motionDetectionEntityId === command.entityId;
      if (k.kind === "sensor") return false;
      return k.entityId === command.entityId;
    });
    if (!dev) throw new Error(t("无法找到指令对应的设备"));

    const spec = await this.specResolver.resolve({
      did: dev.id,
      name: dev.name,
      model: dev.model,
      isOnline: dev.isOnline,
      specType: null,
    });
    const mapped = MiotCommandMapper.map(command, spec);
    if (sourceRevision !== this.sourceRevision) throw new Error("Connection source changed");
    const client = new MiCloudClient(session, this.transport);
    if (mapped.kind === "setProps") {
      await client.setProps(mapped.writes);
    } else {
      await client.action(mapped.call);
    }
  }

  private async startXiaomiQRLogin(): Promise<void> {
    if (this.isPollingQR) return;
    this.isPollingQR = true;
    this.qrStatusText = t("正在获取小米安全登录二维码...");
    invokeTauriVoid("set_pin_popover", { pin: true });
    this.render();

    try {
      const login = new MiAccountLogin(this.transport, this.settings.miCloudRegion);
      const ticket = await login.start();
      this.qrTicket = ticket;
      this.qrStatusText = t("请打开手机「米家 App → 我的 → 右上角扫一扫」确认登录");
      this.render();

      const session = await login.waitForScan(ticket);
      this.invalidateSourceControl();
      // The account-level passToken is never persisted (#27).
      this.settings.miSession = sessionWithoutPassToken(session);
      this.settings.miCloudRegion = normalizeMiCloudRegion(session.region);
      this.settings.connectionMode = "xiaomiCloud";
      this.settings.hasCompletedOnboarding = true;
      // Clear fake demo devices immediately upon real Xiaomi login
      this.devices = [];
      this.scenes = [];
      this.selectedRoom = "全部";
      this.activeSheet = "none";
      this.qrTicket = null;
      this.saveSettings();

      this.qrStatusText = t("已连接小米账号 {user}", { user: maskedMiUserId(session.userId) });
      this.replyBanner = {
        text: t("已登录小米账号 {user}，正在拉取真实设备...", { user: maskedMiUserId(session.userId) }),
        source: t("扫码成功"),
      };
      this.render();

      await this.refreshDevices(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.qrStatusText = t("扫码未完成：{message}", { message: msg });
    } finally {
      this.isPollingQR = false;
      invokeTauriVoid("set_pin_popover", { pin: false });
      this.render();
    }
  }

  private get statusSummaryText(): string {
    if (this.settings.connectionMode === "homeAssistant") return this.isSyncingCloud ? "Home Assistant · Connecting" : `Home Assistant · ${this.onlineDeviceCount} online`;
    if (this.settings.connectionMode === "xiaomiCloud") {
      if (this.isSyncingCloud && this.devices.length === 0) {
        return t("正在从小米云端同步真实设备...");
      }
      if (this.activeDeviceCount > 0) {
        return t("{count} 台开启中 · 共 {online} 台在线", { count: this.activeDeviceCount, online: this.onlineDeviceCount });
      }
      return t("全屋待机 · {online} 台实时在线", { online: this.onlineDeviceCount });
    }
    return t("演示预览 · 点击下方「扫码直连」同步你的真机");
  }

  private get skin(): AppSkin {
    return this.settings.skin;
  }

  private get effectiveAppearance(): "light" | "dark" {
    const prefersLight =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: light)").matches;
    return resolveAppearance(this.settings.appearance, prefersLight);
  }

  private get layout(): LayoutPrefs {
    return this.settings.layout;
  }

  /** Card sizes are per page: "all" or a room name. */
  private get pageKey(): string {
    return this.selectedRoom === "全部" ? "all" : this.selectedRoom;
  }

  private tileSize(dev: SmartDevice): Exclude<TileSize, "auto"> {
    return resolvedSize(chosenSize(this.layout, this.pageKey, dev.id), dev, this.settings.isCompactGridMode, this.settings.climatePanel);
  }

  private saveLayout(): void {
    this.saveSettings();
  }

  /**
   * Re-renders while keeping scroll offsets, and slides every card from its old position to its
   * new one (FLIP), so reorders, resizes and group moves animate instead of jumping.
   */
  private render(): void {
    const focused = document.activeElement as HTMLElement | null;
    const focusedInput =
      focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA")
        ? (focused as HTMLInputElement | HTMLTextAreaElement)
        : null;
    const keepsFocusedDraft = focusedInput ? inputKeepsDraft(focusedInput) : false;
    const focusAttributes = focused
      ? Array.from(focused.attributes)
          .filter((attr) => attr.name === "id" || attr.name.startsWith("data-"))
          .map((attr) => ({ name: attr.name, value: attr.value }))
      : [];
    const focusSnapshot =
      focused && focusAttributes.length > 0
        ? {
            tagName: focused.tagName,
            attributes: focusAttributes,
            value: keepsFocusedDraft ? focusedInput?.value ?? null : null,
            selectionStart: keepsFocusedDraft ? focusedInput?.selectionStart ?? null : null,
            selectionEnd: keepsFocusedDraft ? focusedInput?.selectionEnd ?? null : null,
          }
        : null;
    const hasMountedPopover = this.root.querySelector(":scope > .cc-popover") !== null;
    if (hasMountedPopover) {
      this.root.classList.remove("is-opening");
    }
    const tiles = Array.from(this.root.querySelectorAll<HTMLElement>("[data-tile-id]"));
    const before = new Map(tiles.map((el) => [el.dataset.tileId as string, el.getBoundingClientRect()]));
    const scrollTop = this.root.querySelector(".cc-scroll-area")?.scrollTop ?? 0;
    const roomLeft = this.root.querySelector(".cc-room-scroll")?.scrollLeft ?? 0;
    const sheetScrollTop = this.root.querySelector(".cc-sheet")?.scrollTop ?? 0;

    this.pendingCloudRender = false;
    this.renderNow();

    const area = this.root.querySelector(".cc-scroll-area");
    if (area) area.scrollTop = scrollTop;
    const strip = this.root.querySelector<HTMLElement>(".cc-room-scroll");
    if (strip) strip.scrollLeft = roomLeft;
    const sheet = this.root.querySelector<HTMLElement>(".cc-sheet");
    if (sheet) sheet.scrollTop = sheetScrollTop;

    if (focusSnapshot) {
      const matches = Array.from(
        this.root.querySelectorAll<HTMLElement>(focusSnapshot.tagName.toLowerCase()),
      ).filter((element) =>
        focusSnapshot.attributes.every(
          (attribute) => element.getAttribute(attribute.name) === attribute.value,
        ),
      );
      const replacement = matches.length === 1 ? matches[0] : undefined;
      if (replacement) {
        if (focusSnapshot.value !== null && "value" in replacement) {
          (replacement as HTMLInputElement).value = focusSnapshot.value;
        }
        replacement.focus({ preventScroll: true });
        if (
          focusSnapshot.selectionStart !== null &&
          "setSelectionRange" in replacement
        ) {
          (replacement as HTMLInputElement).setSelectionRange(
            focusSnapshot.selectionStart,
            focusSnapshot.selectionEnd ?? focusSnapshot.selectionStart,
          );
        }
      }
    }

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce && before.size > 0) {
      this.root.querySelectorAll<HTMLElement>("[data-tile-id]").forEach((el) => {
        const id = el.dataset.tileId as string;
        const old = before.get(id);
        if (!old || id === this.draggingId) return;
        const now = el.getBoundingClientRect();
        const dx = old.left - now.left;
        const dy = old.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
          { duration: 340, easing: "cubic-bezier(0.2, 0.9, 0.3, 1.15)" },
        );
      });
    }
    this.applyDragOffset();
    this.animateEntrance = false;
    this.poppedDeviceId = null;
  }

  private renderNow(): void {
    const isDemo = this.settings.connectionMode === "demo";
    const activeUndo =
      this.lastUndoAction && this.lastUndoAction.expiresAtMs > Date.now()
        ? this.lastUndoAction
        : null;
    const scheme = this.effectiveAppearance;
    this.root.dataset.scheme = scheme;
    this.root.classList.toggle("is-native-host", Boolean(window.__TAURI_INTERNALS__));
    const popoverClass = `cc-popover skin-${this.skin} scheme-${scheme} ${this.skin === "classic" ? "" : "is-skinned"} ${this.isEditingLayout ? "is-editing" : ""}`.trim();
    const innerContent = `
        <header class="cc-header">
          <div class="cc-header-top">
            <div class="cc-title-group">
              <div class="cc-home-emblem" aria-hidden="true">${SF_ICONS.houseFill}</div>
              <div class="cc-title-stack">
                <div class="cc-title-row">
                  ${
                    this.homes.length > 1
                      ? `<button class="cc-home-switch" id="btn-home-menu" aria-expanded="${this.isHomeMenuOpen}" aria-label="${t("切换家庭")}">
                          <span class="cc-home-title">${this.escapeHtml(this.homeTitle)}</span>
                          <span class="cc-home-caret ${this.isHomeMenuOpen ? "is-open" : ""}">${SF_ICONS.chevronDown}</span>
                        </button>`
                      : `<span class="cc-home-title">${this.escapeHtml(this.homeTitle)}</span>`
                  }
                  <span class="cc-mode-pill ${isDemo ? "is-demo" : "is-cloud"}">
                    ${isDemo ? t("演示预览") : this.settings.connectionMode === "homeAssistant" ? "Home Assistant" : t("Miot 直连")}
                  </span>
                </div>
                <div class="cc-subtitle">${this.escapeHtml(this.isEditingLayout ? t("拖动卡片排序 · 点右下角圆弧手柄改大小") : this.statusSummaryText)}</div>
              </div>
            </div>

            <div class="cc-header-controls">
              ${this.renderAllOffControl()}
              <button
                class="cc-circle-btn ${this.isDeviceSearchOpen ? "is-selected" : ""}"
                id="btn-device-search"
                title="${t("搜索设备或房间 (Ctrl+F)")}"
                aria-label="${t("搜索设备或房间")}"
                aria-expanded="${this.isDeviceSearchOpen}"
              >
                ${SF_ICONS.search}
              </button>
              <button
                class="cc-circle-btn"
                id="btn-hide-panel"
                title="${t("收起面板到右下角托盘 (Esc)")}"
                aria-label="${t("收起面板")}"
              >
                ${SF_ICONS.chevronDown}
              </button>
            </div>
          </div>

          ${this.renderEnvironmentStrip()}
        </header>

        ${this.isDeviceSearchOpen || this.replyBanner || activeUndo ? `
        <section class="cc-search-section">
          ${this.isDeviceSearchOpen ? `
          <div class="cc-spotlight-bar">
            <span class="cc-spotlight-icon" aria-hidden="true">${SF_ICONS.search}</span>
            <input
              id="device-search"
              class="cc-spotlight-input"
              type="text"
              value="${this.escapeHtml(this.deviceSearch)}"
              placeholder="${t("搜索设备或房间 (Ctrl+F)")}"
              aria-label="${t("搜索设备或房间")}"
            />
          </div>` : ""}
          ${this.replyBanner || activeUndo ? `
            <div class="cc-feedback-card ${this.replyBanner?.isError ? "is-error" : ""}" role="status">
              <div class="cc-feedback-row">
                ${this.replyBanner ? `
                  <span class="cc-feedback-badge">${this.escapeHtml(this.replyBanner.source)}</span>
                  <span class="cc-feedback-text">${this.escapeHtml(this.replyBanner.text)}</span>` : ""}
                ${activeUndo ? `<button class="cc-inline-pill" id="btn-undo">${t("撤销")}</button>` : ""}
              </div>
            </div>` : ""}
        </section>` : ""}

        ${this.haConnectionError ? `<div class="cc-feedback-card is-error" role="alert" data-ha-error><span class="cc-feedback-badge">Home Assistant</span><span class="cc-feedback-text">${this.escapeHtml(this.haConnectionError)}</span></div>` : ""}

        <section class="cc-quick-strip">
          ${quickActions().map(
            (act) => `
            <button class="cc-quick-pill tint-${act.tint}" data-quick-action="${act.id}">
              <span class="cc-quick-icon">${act.icon}</span>
              <span>${this.escapeHtml(act.title)}</span>
            </button>
          `,
          ).join("")}
          ${this.settings.connectionMode === "homeAssistant" ? this.scenes.map((scene) => `<button class="cc-quick-pill tint-blue" data-ha-scene="${this.escapeHtml(scene.id)}"><span class="cc-quick-icon">${SF_ICONS.sparkles}</span><span>${this.escapeHtml(scene.name)}</span></button>`).join("") : ""}
        </section>


        <div class="cc-room-bar">
          <div class="cc-room-track">
          <div class="cc-room-scroll">
            ${this.rooms
              .map(
                (room) => `
              <button
                class="cc-room-pill ${this.selectedRoom === room ? "is-active" : ""}"
                data-room="${this.escapeHtml(room)}"
                aria-pressed="${this.selectedRoom === room}"
              >
                ${this.escapeHtml(room === "全部" ? t("全部") : room)}
              </button>
            `,
              )
              .join("")}
          </div>
          </div>
          <button
            class="cc-circle-btn is-small"
            id="btn-toggle-grid"
            title="${this.settings.isCompactGridMode ? t("切换为单列详情视图") : t("切换为双列控制中心磁贴")}"
            aria-label="${this.settings.isCompactGridMode ? t("切换为单列详情视图") : t("切换为双列控制中心磁贴")}"
            aria-pressed="${this.settings.isCompactGridMode}"
          >
            ${this.settings.isCompactGridMode ? SF_ICONS.grid2x2 : SF_ICONS.grid1x2}
          </button>
        </div>

        <div class="cc-divider"></div>

        <main class="cc-scroll-area">
          ${this.renderDeviceGrid()}
        </main>

        <div class="cc-divider"></div>

        <footer class="cc-footer">
          <div class="cc-footer-status">
            <span class="cc-status-dot ${this.isSyncingCloud ? "is-syncing" : this.settings.connectionMode === "homeAssistant" ? (this.haConnectionError || !this.settings.haBaseURL || !this.settings.haToken ? "is-demo" : "is-online") : isDemo ? "is-demo" : "is-online"}"></span>
            <span class="cc-footer-label">
              ${
                this.settings.connectionMode === "xiaomiCloud" && this.settings.miSession
                  ? t("米家账号 {user} · {count} 台设备", { user: maskedMiUserId(this.settings.miSession.userId), count: this.devices.length })
                  : this.settings.connectionMode === "homeAssistant" ? `Home Assistant · ${this.devices.length}` : t("演示模式 · 未连接米家云")
              }
            </span>
          </div>

          <div class="cc-footer-actions">
            ${
              this.settings.connectionMode !== "homeAssistant" && (!this.settings.miSession || isDemo)
                ? `<button class="cc-footer-pill is-accent" id="btn-footer-qr" title="${t("用手机米家 App 扫码直连真实设备")}">
                    ${SF_ICONS.qrcode}
                    <span>${t("扫码直连")}</span>
                  </button>`
                : ""
            }
            <button
              class="cc-footer-icon-btn"
              id="btn-toggle-appearance"
              title="${scheme === "light" ? t("切换深色模式") : t("切换浅色模式")}"
              aria-label="${scheme === "light" ? t("切换深色模式") : t("切换浅色模式")}"
            >
              ${scheme === "light" ? SF_ICONS.moonStarsFill : SF_ICONS.sunMaxFill}
            </button>
            <button
              class="cc-footer-icon-btn ${this.isSyncingCloud ? "is-spinning" : ""}"
              id="btn-refresh"
              title="${t("立即同步最新设备状态")}"
              aria-label="${t("立即同步最新设备状态")}"
            >
              ${SF_ICONS.arrowClockwise}
            </button>
            <button
              class="cc-footer-icon-btn"
              id="btn-settings"
              title="${t("打开设置")}"
              aria-label="${t("打开设置")}"
            >
              ${SF_ICONS.sliderHorizontal}
            </button>
            <button
              class="cc-footer-pill is-danger"
              id="btn-quit-app"
              title="${t("完全退出 MenuBarMijia")}"
            >
              ${SF_ICONS.power}
              <span>${t("退出")}</span>
            </button>
          </div>
        </footer>
        ${window.__TAURI_INTERNALS__ ? `
          <div class="cc-panel-resize" id="panel-resize" title="${t("拖动左上角调整面板大小")}" aria-hidden="true"></div>
        ` : ""}

        ${this.activeSheet === "onboarding" ? this.renderOnboardingModal() : ""}
        ${this.activeSheet === "settings" ? this.renderSettingsModal() : ""}
        ${this.activeLiveCameraId !== null ? this.renderCameraLiveModal() : ""}
        ${this.renderHomeMenu()}
        ${this.renderContextMenu()}
        ${this.renderPrompt()}
    `;
    const existingPopover = this.root.querySelector<HTMLElement>(":scope > .cc-popover");
    if (existingPopover) {
      if (existingPopover.className !== popoverClass) {
        existingPopover.className = popoverClass;
      }
      existingPopover.innerHTML = innerContent;
    } else {
      this.root.innerHTML = `<div class="${popoverClass}">${innerContent}</div>`;
    }

    this.bindEvents();
  }

  private renderEnvironmentStrip(): string {
    const envChips = this.computedEnvironmentReadings;
    const watts = this.totalPowerWatts;
    if (envChips.length === 0 && watts < 1) return "";
    return `
      <div class="cc-env-strip">
        ${envChips
          .map(
            (env) => `
          <div class="cc-env-chip">
            <span class="cc-env-icon">${SF_ICONS.sensorFill}</span>
            <span class="cc-env-label">${this.escapeHtml(env.label)}</span>
            ${env.temperature !== null ? `<strong class="cc-env-val">${formatTemperature(env.temperature, undefined, 1)}</strong>` : ""}
            ${env.humidity !== null ? `<span class="cc-env-hum">· ${Math.round(env.humidity)}%</span>` : ""}
          </div>
        `,
          )
          .join("")}
        ${
          watts >= 1
            ? `
          <div class="cc-env-chip is-power">
            <span class="cc-env-icon">${SF_ICONS.boltFill}</span>
            <strong class="cc-env-val">${Math.round(watts)}W</strong>
          </div>
        `
            : ""
        }
      </div>
    `;
  }

  private renderDeviceGrid(): string {
    const devices = this.filteredDevices;
    if (this.deviceSearch.trim() && devices.length === 0 && this.devices.length > 0) {
      return `<div class="cc-empty-state" role="status">${t("找不到匹配的设备")}</div>`;
    }
    if (this.settings.connectionMode === "homeAssistant" && this.devices.length === 0) return `<div class="cc-empty-state"><div class="cc-empty-title">Home Assistant</div><div class="cc-empty-subtitle">${this.isSyncingCloud ? "Connecting…" : "No connected devices. Check the saved URL, token and endpoint permission."}</div><button class="cc-btn-secondary" id="btn-empty-settings">Settings</button></div>`;
    if (this.settings.connectionMode === "xiaomiCloud" && this.devices.length === 0) {
      if (this.isSyncingCloud) {
        return `
          <div class="cc-empty-state">
            <div class="cc-empty-icon is-pulsing">${SF_ICONS.sparkles}</div>
            <div class="cc-empty-title">${t("正在同步你的真实米家设备…")}</div>
            <div class="cc-empty-subtitle">${t("正在从小米云端拉取房间、MIoT 规格与实时状态")}</div>
          </div>
        `;
      }
      return `
        <div class="cc-empty-state">
          <div class="cc-empty-icon">${SF_ICONS.houseFill}</div>
          <div class="cc-empty-title">${t("尚未同步到米家设备")}</div>
          <div class="cc-empty-subtitle">当前地区（${this.escapeHtml(normalizeMiCloudRegion(this.settings.miSession?.region ?? this.settings.miCloudRegion))}）没有设备，可尝试切换地区</div>
          <div class="cc-empty-actions">
            <button class="cc-btn-primary" id="btn-empty-resync">${t("重新同步设备")}</button>
            <button class="cc-btn-secondary" id="btn-empty-settings">${t("切换账号 / 设置")}</button>
          </div>
        </div>
      `;
    }

    if (devices.length === 0) {
      return `<div class="cc-empty-state">
        <div class="cc-empty-title">${t("当前没有可显示的设备")}</div>
        <button class="cc-btn-secondary" id="btn-empty-settings">${t("打开设置")}</button>
      </div>`;
    }
    const isAll = this.selectedRoom === "全部";
    const ordered = withAliases(this.layout, applyOrder(this.layout.order, devices));
    const sections = pageSections(this.layout, ordered, isAll);
    const bento = this.skin === "bento" && this.settings.isCompactGridMode;
    let index = 0;
    return sections
      .map((section) => {
        const collapsed = this.layout.collapsed.includes(scopedKey(this.pageKey, section.id));
        const spanMap = spans(section.devices, (d) => (this.expandedDeviceId === d.id ? "full" : this.tileSize(d)), bento);
        const header =
          section.title === null
            ? ""
            : `<button class="cc-group-header ${collapsed ? "is-collapsed" : ""}" data-collapse="${this.escapeHtml(section.id)}" ${section.groupId ? `data-group-id="${this.escapeHtml(section.groupId)}"` : ""}>
                <span class="cc-group-caret">${SF_ICONS.chevronDown}</span>
                <span class="cc-group-title">${this.escapeHtml(section.title)}</span>
                <span class="cc-group-count">${section.devices.length}</span>
                <span class="cc-group-rule"></span>
              </button>`;
        const body = collapsed
          ? ""
          : `<div class="cc-devices-grid is-flow ${bento ? "is-bento" : ""}">
              ${section.devices.map((dev) => this.renderDeviceTile(dev, spanMap.get(dev.id) ?? 6, index++)).join("")}
            </div>`;
        return `<section class="cc-group">${header}${body}</section>`;
      })
      .join("");
  }

  private devicePaletteClass(dev: SmartDevice): string {
    switch (dev.kind.kind) {
      case "light":
        return "palette-amber";
      case "climate":
        return "palette-blue";
      case "fan":
        return "palette-mint";
      case "plug":
        return "palette-green";
      case "vacuum":
        return "palette-indigo";
      case "camera":
        return "palette-blue";
      case "sensor":
        return "palette-teal";
    }
  }

  private deviceSvgIcon(dev: SmartDevice): string {
    switch (dev.kind.kind) {
      case "light":
        return SF_ICONS.lightbulbFill;
      case "climate":
        return SF_ICONS.snowflake;
      case "fan":
        return SF_ICONS.fanbladesFill;
      case "plug":
        return SF_ICONS.powerplugFill;
      case "vacuum":
        return SF_ICONS.sparkles;
      case "camera":
        return SF_ICONS.videoFill;
      case "sensor":
        return SF_ICONS.sensorFill;
    }
  }

  private renderDeviceTile(dev: SmartDevice, span: number, index: number): string {
    const size = this.tileSize(dev);
    const attrs = `data-tile-id="${this.escapeHtml(dev.id)}" style="grid-column: span ${span}; --i: ${Math.min(index, 12)}; --jd: -${Math.round((performance.now() + (index * 137) % 560) % 560)}ms"`;
    const motion = `${this.animateEntrance && this.skin !== "classic" ? "is-entering" : ""} ${this.poppedDeviceId === dev.id ? "is-popped" : ""} ${this.draggingId === dev.id ? "is-dragging" : ""}`;
    const sizeTitle = TILE_SIZES.find((item) => item.id === size)?.title ?? "";
    const badge = this.isEditingLayout
      ? `<button class="cc-resize-handle" data-resize-handle="${this.escapeHtml(dev.id)}" data-cycle-size="${this.escapeHtml(dev.id)}" data-tile-size="${size}" title="${t("切换卡片大小")}：${sizeTitle}" aria-label="${t("切换卡片大小")}，${sizeTitle}"><svg class="cc-resize-arc" viewBox="0 0 28 28" aria-hidden="true"><path d="M 22 10 A 12 12 0 0 1 10 22" /></svg></button>`
      : "";
    if (dev.kind.kind === "sensor" && !(this.skin === "bento" && span < 6)) {
      return this.renderSensorCard(dev, dev.kind, span < 6, attrs, motion, badge);
    }
    if (dev.kind.kind === "climate" && size !== "half") {
      return this.renderClimateStrip(dev, dev.kind, size === "panel", attrs, motion, badge);
    }
    const isExpanded = this.expandedDeviceId === dev.id || size === "panel";
    const isOn = isDeviceActiveOn(dev);
    const kind = dev.kind.kind;
    const palette = this.devicePaletteClass(dev);
    const svg = this.deviceSvgIcon(dev);
    const hasDrawer = kind === "light" || kind === "climate" || kind === "fan" || kind === "camera";
    const subtitle =
      this.selectedRoom === "全部"
        ? `${dev.roomName} · ${deviceStatusSummary(dev)}`
        : deviceStatusSummary(dev);

    const dim = this.dimPreview?.id === dev.id ? this.dimPreview.percent : null;
    const fill = kind === "light" && this.skin !== "classic" && !isExpanded
      ? dim ?? (isOn && dev.kind.kind === "light" ? dev.kind.brightnessPercent ?? 100 : 0)
      : 0;
    const shownSubtitle = dim !== null ? t("亮度 {percent}%", { percent: dim }) : subtitle;
    return `
      <div class="cc-tile ${palette} ${isOn ? "is-active" : ""} ${isExpanded ? "is-expanded" : ""} ${dev.isOnline ? "" : "is-offline"} ${kind === "light" ? "is-light" : ""} ${this.skin === "bento" && span < 6 ? "is-bento-tile" : ""} ${motion}" ${attrs}>
        ${fill > 0 ? `<span class="cc-tile-fill" style="width:${fill}%"></span>` : ""}
        ${badge}
        <div class="cc-tile-header">
          <button
            class="cc-tile-orb"
            data-toggle-device="${this.escapeHtml(dev.id)}"
            title="${kind === "sensor" ? dev.name : t("点击直接切换开关")}"
            aria-label="${this.escapeHtml(t("{name} 开关", { name: dev.name }))}"
            aria-pressed="${isOn}"
          >
            ${svg}
          </button>

          <button
            class="cc-tile-body"
            data-body-device="${this.escapeHtml(dev.id)}"
            title="${kind === "camera" ? t("点击放大打开摄像机实时画面") : hasDrawer ? t("点击展开精细调节") : t("点击切换开关")}"
            aria-label="${this.escapeHtml(dev.name)}，${this.escapeHtml(shownSubtitle)}"
            aria-pressed="${isOn}"
          >
            <div class="cc-tile-name">${this.escapeHtml(dev.name)}</div>
            <div class="cc-tile-status">${this.escapeHtml(shownSubtitle)}</div>
          </button>

          ${
            hasDrawer && size !== "panel" && (this.skin === "classic" || !this.settings.isCompactGridMode || isExpanded)
              ? `<button
                  class="cc-tile-chevron ${isExpanded ? "is-open" : ""}"
                  data-expand-device="${this.escapeHtml(dev.id)}"
                  title="${isExpanded ? t("收起详细控制") : t("展开详细控制")}"
                  aria-label="${isExpanded ? t("收起") : t("展开")} ${this.escapeHtml(t("{name} 详细控制", { name: dev.name }))}"
                  aria-expanded="${isExpanded}"
                >
                  ${SF_ICONS.chevronRight}
                </button>`
              : ""
          }
        </div>
        ${isExpanded && hasDrawer ? this.renderDeviceDrawer(dev) : ""}
      </div>
    `;
  }

  private renderSensorCard(
    dev: SmartDevice,
    k: Extract<SmartDevice["kind"], { kind: "sensor" }>,
    compact: boolean,
    attrs: string,
    motion: string,
    badge: string,
  ): string {
    const c = comfort(k.temperature, k.humidity);
    const name = dev.name.replace(t("米家智能温湿度计"), t("温湿度计")) || dev.name;
    const temp = k.temperature !== null ? formatTemperatureValue(k.temperature, undefined, 1) : "--";
    const hum = k.humidity !== null ? Math.round(k.humidity) : null;
    const room = this.selectedRoom === "全部" ? `<span class="cc-sensor-room">${this.escapeHtml(dev.roomName)}</span>` : "";
    const sensorAria = `${t("{name}，温度 {temp}", { name, temp: k.temperature !== null ? formatTemperature(k.temperature, undefined, 1) : "--" })}${hum !== null ? t("，湿度 {humidity}%", { humidity: hum }) : ""}${dev.isOnline ? "" : t("，离线")}`;
    if (compact) {
      return `
        <div class="cc-tile cc-sensor is-compact ${dev.isOnline ? "" : "is-offline"} ${motion}" ${attrs} role="group" aria-label="${this.escapeHtml(sensorAria)}">
          ${badge}
          <div class="cc-sensor-top">
            <span class="cc-sensor-name">${this.escapeHtml(name)}</span>
            <span class="cc-comfort is-${c.level}">${c.label}</span>
          </div>
          <div class="cc-sensor-main">
            <span class="cc-sensor-temp">${temp}<small>${temperatureSymbol()}</small></span>
            ${hum !== null ? `<span class="cc-sensor-hum">💧 ${hum}%</span>` : ""}
          </div>
          <div class="cc-hum-bar"><span style="width:${hum ?? 0}%"></span></div>
        </div>`;
    }
    const ring = hum !== null
      ? `<div class="cc-hum-ring" style="--h:${hum}">
          <svg viewBox="0 0 64 64"><circle class="track" cx="32" cy="32" r="27"/><circle class="comfy" cx="32" cy="32" r="27" pathLength="100"/><circle class="val" cx="32" cy="32" r="27" pathLength="100"/></svg>
          <span>${hum}%</span>
        </div>`
      : "";
    return `
      <div class="cc-tile cc-sensor ${dev.isOnline ? "" : "is-offline"} ${motion}" ${attrs} role="group" aria-label="${this.escapeHtml(sensorAria)}">
        ${badge}
        <div class="cc-sensor-wide">
          <div class="cc-sensor-info">
            <div class="cc-sensor-top"><span class="cc-sensor-name is-strong">${this.escapeHtml(name)}</span>${room}</div>
            <span class="cc-sensor-temp is-big">${temp}<small>${temperatureSymbol()}</small></span>
            <div class="cc-sensor-meta">
              <span class="cc-comfort is-${c.level}">${c.label}</span>
              ${k.battery !== null ? `<span class="cc-sensor-batt ${k.battery <= 20 ? "is-low" : ""}">🔋 ${k.battery}%</span>` : ""}
            </div>
          </div>
          ${ring}
        </div>
      </div>`;
  }

  private renderClimateStrip(
    dev: SmartDevice,
    k: Extract<SmartDevice["kind"], { kind: "climate" }>,
    forceOpen: boolean,
    attrs: string,
    motion: string,
    badge: string,
  ): string {
    const running = dev.isOnline && k.isOn && k.hvacMode !== "off";
    const open = forceOpen || this.expandedDeviceId === dev.id;
    const id = this.escapeHtml(dev.id);
    const modeLabel: Record<string, string> = { cool: t("制冷"), heat: t("制热"), dry: t("除湿"), fan_only: t("送风"), auto: t("自动") };
    const status = running
      ? [
          modeLabel[k.hvacMode] ?? k.hvacMode,
          k.currentTemperature !== null
            ? t("室温 {temp}", { temp: formatTemperature(k.currentTemperature, undefined, 1) })
            : "",
        ].filter(Boolean).join(" · ")
      : t("已关闭");
    const subtitle = this.selectedRoom === "全部" ? `${dev.roomName} · ${status}` : status;
    const span = Math.max(k.maxTemp - k.minTemp, 1);
    const progress = Math.min(Math.max((k.targetTemperature - k.minTemp) / span, 0), 1) * 100;
    const modes = (k.availableModes.length > 0 ? k.availableModes : ["cool", "heat", "dry", "fan_only"]).filter((m) => m !== "off");
    const unit = getTemperatureUnit();
    const temp = formatTemperatureValue(k.targetTemperature);
    return `
      <div class="cc-tile cc-climate ${running ? "is-active" : ""} ${dev.isOnline ? "" : "is-offline"} ${motion}" ${attrs}>
        ${badge}
        <div class="cc-climate-strip">
          <button class="cc-climate-power ${running ? "is-on" : ""}" data-toggle-device="${id}" title="${running ? t("关闭空调") : t("打开空调")}" aria-label="${running ? t("关闭 {name}", { name: this.escapeHtml(dev.name) }) : t("打开 {name}", { name: this.escapeHtml(dev.name) })}" aria-pressed="${running}">
            <span aria-hidden="true" ${k.hvacMode === "heat" ? "" : "hidden"}>🔥</span><span aria-hidden="true" ${k.hvacMode === "heat" ? "hidden" : ""}>${SF_ICONS.snowflake}</span>
          </button>
          <button class="cc-climate-name" data-expand-device="${id}" aria-label="${this.escapeHtml(dev.name)}，${this.escapeHtml(subtitle)}" aria-expanded="${open}">
            <span class="cc-tile-name">${this.escapeHtml(dev.name)}</span>
            <span class="cc-tile-status">${this.escapeHtml(subtitle)} ${forceOpen ? "" : `<i class="cc-mini-caret ${open ? "is-open" : ""}">${SF_ICONS.chevronDown}</i>`}</span>
          </button>
          <button class="cc-climate-step" data-acstep="${id}:-1" title="${t("降低温度")}" aria-label="${t("降低目标温度")}">−</button>
          <span class="cc-climate-temp" aria-label="${t("目标温度 {temp}", { temp: formatTemperature(k.targetTemperature) })}">${temp}<small>${temperatureSymbol(unit)}</small></span>
          <button class="cc-climate-step" data-acstep="${id}:1" title="${t("升高温度")}" aria-label="${t("升高目标温度")}">＋</button>
        </div>
        <div class="cc-climate-gauge" role="progressbar" aria-label="${t("目标温度进度")}" aria-valuemin="${k.minTemp}" aria-valuemax="${k.maxTemp}" aria-valuenow="${k.targetTemperature}"><span style="width:${progress}%"></span></div>
        ${
          open
            ? `<div class="cc-climate-more">
                <div class="cc-segmented-pills is-even">
                  ${modes.map((m) => `<button class="cc-seg-pill ${running && k.hvacMode === m ? "is-active" : ""}" data-acmode="${id}:${m}" aria-pressed="${running && k.hvacMode === m}">${modeLabel[m] ?? m}</button>`).join("")}
                </div>
                ${
                  k.availableFanModes.length > 0
                    ? `<div class="cc-segmented-pills"><span class="cc-pill-label">${t("风速")}</span>${k.availableFanModes
                        .map((f) => `<button class="cc-seg-pill ${k.fanMode === f ? "is-active" : ""}" data-acfan="${id}:${this.escapeHtml(f)}" aria-pressed="${k.fanMode === f}">${this.escapeHtml(localizeFanMode(f))}</button>`)
                        .join("")}</div>`
                    : ""
                }
              </div>`
            : ""
        }
      </div>`;
  }

  private renderHomeMenu(): string {
    if (!this.isHomeMenuOpen || this.homes.length < 2) return "";
    const item = (id: string | null, label: string, count?: number) => `
      <button class="cc-menu-item ${this.settings.selectedHomeId === id ? "is-checked" : ""}" data-home="${id ?? ""}">
        <span>${this.escapeHtml(label)}</span>${count !== undefined ? `<small>${count}</small>` : ""}
      </button>`;
    return `
      <div class="cc-menu-scrim" data-close-menus></div>
      <div class="cc-menu cc-home-menu">
        ${item(null, t("全部家庭"))}
        <div class="cc-menu-sep"></div>
        ${this.homes.map((h) => item(h.id, h.name, h.deviceCount)).join("")}
      </div>`;
  }

  private renderContextMenu(): string {
    const m = this.ctxMenu;
    if (!m) return "";
    const pos = `left:${Math.min(m.x, window.innerWidth - 230)}px; top:${Math.min(m.y, window.innerHeight - 260)}px`;
    if (m.groupId) {
      const g = this.layout.groups.find((x) => x.id === m.groupId);
      if (!g) return "";
      const gid = this.escapeHtml(g.id);
      return `
        <div class="cc-menu-scrim" data-close-menus></div>
        <div class="cc-menu" style="${pos}">
          <div class="cc-menu-title">${this.escapeHtml(g.name)}</div>
          <button class="cc-menu-item" data-group-action="rename:${gid}">重命名</button>
          <button class="cc-menu-item" data-group-action="up:${gid}">上移分组</button>
          <button class="cc-menu-item" data-group-action="down:${gid}">下移分组</button>
          <div class="cc-menu-sep"></div>
          <button class="cc-menu-item is-danger" data-group-action="delete:${gid}">删除分组</button>
        </div>`;
    }
    const dev = this.devices.find((d) => d.id === m.deviceId);
    if (!dev) return "";
    const id = this.escapeHtml(dev.id);
    const size = chosenSize(this.layout, this.pageKey, dev.id);
    const current = this.layout.groupMap[dev.id];
    return `
      <div class="cc-menu-scrim" data-close-menus></div>
      <div class="cc-menu" style="${pos}">
        <div class="cc-menu-title">${this.escapeHtml(this.layout.aliases[dev.id] ?? dev.name)}</div>
        <div class="cc-menu-label">${t("卡片大小（本页）")}</div>
        <div class="cc-menu-chips">
          ${TILE_SIZES.map((t) => `<button class="cc-menu-chip ${size === t.id ? "is-active" : ""}" data-set-size="${id}:${t.id}">${t.title}</button>`).join("")}
        </div>
        <div class="cc-menu-label">${t("移到分组")}</div>
        <div class="cc-menu-chips">
          ${this.layout.groups.map((g) => `<button class="cc-menu-chip ${current === g.id ? "is-active" : ""}" data-set-group="${id}:${this.escapeHtml(g.id)}">${this.escapeHtml(g.name)}</button>`).join("")}
          ${current ? `<button class="cc-menu-chip" data-set-group="${id}:">不分组</button>` : ""}
          <button class="cc-menu-chip is-add" data-new-group="${id}">＋ 新建</button>
        </div>
        <div class="cc-menu-sep"></div>
        <button class="cc-menu-item" data-rename-device="${id}">重命名…</button>
        <button class="cc-menu-item" data-start-editing>${t("编辑布局")}</button>
        <button class="cc-menu-item" data-hide-device="${id}">${t("隐藏此设备")}</button>
      </div>`;
  }

  private renderPrompt(): string {
    const p = this.prompt;
    if (!p) return "";
    let title = t("新建分组");
    let value = "";
    let placeholder = t("例如：灯光、电器、环境");
    if (p.kind === "renameGroup") {
      title = t("重命名分组");
      value = this.layout.groups.find((g) => g.id === p.groupId)?.name ?? "";
    } else if (p.kind === "renameDevice") {
      title = t("重命名设备");
      const dev = this.devices.find((d) => d.id === p.deviceId);
      placeholder = dev?.name ?? "";
      value = this.layout.aliases[p.deviceId] ?? dev?.name ?? "";
    }
    const hasAlias = p.kind === "renameDevice" && Boolean(this.layout.aliases[p.deviceId]);
    return `
      <div class="cc-prompt-backdrop" data-prompt-cancel></div>
      <div class="cc-prompt">
        <strong>${title}</strong>
        <input id="prompt-input" class="cc-prompt-input" type="text" value="${this.escapeHtml(value)}" placeholder="${this.escapeHtml(placeholder)}" />
        ${p.kind === "renameDevice" ? `<small>${t("只在本 App 显示，不会修改米家里的名字")}</small>` : ""}
        <div class="cc-prompt-actions">
          ${hasAlias ? `<button class="cc-btn-secondary" id="btn-prompt-reset">${t("恢复原名")}</button>` : ""}
          <button class="cc-btn-secondary" data-prompt-cancel>${t("取消")}</button>
          <button class="cc-btn-primary" id="btn-prompt-save">${t("保存")}</button>
        </div>
      </div>`;
  }

  private renderDeviceDrawer(dev: SmartDevice): string {
    const k = dev.kind;
    if (k.kind === "light") {
      const bri = k.brightnessPercent ?? 80;
      const ct = k.colorTempKelvin ?? 4000;
      return `
        <div class="cc-tile-drawer">
          ${k.availableEffects.length > 0 ? `
            <div class="cc-segmented-pills">
              ${k.availableEffects.map((effect) => `
                <button class="cc-seg-pill ${k.currentEffect === effect ? "is-active" : ""}"
                  data-lighteffect="${this.escapeHtml(dev.id)}" data-effect="${this.escapeHtml(effect)}"
                  aria-pressed="${k.currentEffect === effect}">
                  ${this.escapeHtml(localizeEffect(effect))}
                </button>
              `).join("")}
            </div>
          ` : ""}
          <div class="cc-slider-group">
            <div class="cc-slider-label">
              <span>${t("亮度")}</span>
              <strong>${bri}%</strong>
            </div>
            <input class="cc-range is-amber" type="range" min="1" max="100" value="${bri}" data-brightness="${this.escapeHtml(dev.id)}" aria-label="${t("亮度")}" aria-valuemin="1" aria-valuemax="100" aria-valuenow="${bri}" />
          </div>
          <div class="cc-slider-group">
            <div class="cc-slider-label">
              <span>${t("色温")}</span>
              <strong>${ct}K</strong>
            </div>
            <input class="cc-range is-kelvin" type="range" min="${k.minKelvin}" max="${k.maxKelvin}" step="100" value="${ct}" data-colortemp="${this.escapeHtml(dev.id)}" aria-label="${t("色温")}" aria-valuemin="${k.minKelvin}" aria-valuemax="${k.maxKelvin}" aria-valuenow="${ct}" />
          </div>
        </div>
      `;
    }
    if (k.kind === "climate") {
      const modes: ReadonlyArray<{ readonly code: string; readonly label: string }> = [
        { code: "cool", label: t("制冷") },
        { code: "heat", label: t("制热") },
        { code: "dry", label: t("除湿") },
        { code: "fan_only", label: t("送风") },
        { code: "auto", label: t("自动") },
      ];
      return `
        <div class="cc-tile-drawer">
          <div class="cc-slider-group">
            <div class="cc-slider-label">
              <span>${t("目标温度")}</span>
              <strong>${formatTemperature(k.targetTemperature)}</strong>
            </div>
            <input class="cc-range is-blue" type="range" min="${formatTemperatureValue(k.minTemp)}" max="${formatTemperatureValue(k.maxTemp)}" step="${displayStep(k.step)}" value="${formatTemperatureValue(k.targetTemperature)}" data-actemp="${this.escapeHtml(dev.id)}" aria-label="${t("目标温度")}" aria-valuemin="${formatTemperatureValue(k.minTemp)}" aria-valuemax="${formatTemperatureValue(k.maxTemp)}" aria-valuetext="${formatTemperature(k.targetTemperature)}" />
          </div>
          <div class="cc-segmented-pills">
            ${modes
              .map(
                (m) => `
              <button class="cc-seg-pill ${k.hvacMode === m.code ? "is-active" : ""}" data-acmode="${this.escapeHtml(dev.id)}:${m.code}">
                ${m.label}
              </button>
            `,
              )
              .join("")}
          </div>
        </div>
      `;
    }
    if (k.kind === "fan") {
      const modes =
        k.availablePresetModes.length > 0
          ? k.availablePresetModes
          : ["Level 1", "Level 2", "Level 3", "Level 4"];
      const telemetryParts: string[] = [];
      if (k.pm25Density !== undefined && k.pm25Density !== null) {
        const aq = localizeAirQuality(k.airQuality, k.pm25Density);
        telemetryParts.push(`${t("空气质量")} PM2.5 ${k.pm25Density}${aq ? ` (${aq})` : ""}`);
      } else if (k.airQuality) {
        const aq = localizeAirQuality(k.airQuality, null);
        if (aq) telemetryParts.push(`${t("空气质量")} ${aq}`);
      }
      if (k.temperature !== undefined && k.temperature !== null && k.humidity !== undefined && k.humidity !== null) {
        telemetryParts.push(`${t("温湿度")} ${formatTemperature(k.temperature, undefined, 1)} · ${Math.round(k.humidity)}%`);
      } else if (k.temperature !== undefined && k.temperature !== null) {
        telemetryParts.push(formatTemperature(k.temperature, undefined, 1));
      } else if (k.humidity !== undefined && k.humidity !== null) {
        telemetryParts.push(`${Math.round(k.humidity)}%`);
      }
      if (k.filterLifePercent !== undefined && k.filterLifePercent !== null) {
        telemetryParts.push(`${t("滤芯余量")} ${k.filterLifePercent}%`);
      }
      return `
        <div class="cc-tile-drawer">
          ${
            telemetryParts.length > 0
              ? `<div class="cc-slider-label"><span>${this.escapeHtml(telemetryParts.join(" · "))}</span></div>`
              : ""
          }
          ${
            k.percentage !== null
              ? `<div class="cc-slider-group">
                  <div class="cc-slider-label">
                    <span>${t("风速")}</span>
                    <strong>${k.percentage}%</strong>
                  </div>
                  <input class="cc-range is-blue" type="range" min="1" max="100" value="${Math.max(1, k.percentage)}" data-fanpercent="${this.escapeHtml(dev.id)}" aria-label="${t("风速")}" aria-valuemin="1" aria-valuemax="100" aria-valuenow="${Math.max(1, k.percentage)}" />
                </div>`
              : ""
          }
          <div class="cc-segmented-pills">
            ${modes
              .map(
                (preset) => `
              <button class="cc-seg-pill ${k.presetMode === preset ? "is-active" : ""}" data-fanpreset="${this.escapeHtml(dev.id)}:${this.escapeHtml(preset)}" aria-pressed="${k.presetMode === preset}">
                ${this.escapeHtml(localizeFanPreset(IntentReply.fanSpeedLabel(preset)))}
              </button>
            `,
              )
              .join("")}
            ${
              k.isOscillating !== null
                ? `<button class="cc-seg-pill ${k.isOscillating ? "is-active" : ""}" data-fanosc="${this.escapeHtml(dev.id)}" aria-pressed="${k.isOscillating}">
                    摇头 ${k.isOscillating ? t("开") : t("关")}
                  </button>`
                : ""
            }
          </div>
        </div>
      `;
    }
    if (k.kind === "camera") {
      const id = this.escapeHtml(dev.id);
      const motionOn = Boolean(k.isMotionDetectionOn);
      return `
        <div class="cc-tile-drawer">
          <div class="cc-segmented-pills">
            <button class="cc-seg-pill is-active" data-camera-live="${id}">
              ${t("放大实时画面")}
            </button>
            <button class="cc-seg-pill ${!k.isOn ? "is-active" : ""}" data-toggle-device="${id}" aria-pressed="${!k.isOn}">
              ${k.isOn ? t("镜头休眠") : t("唤醒镜头")}
            </button>
            ${
              k.motionDetectionEntityId
                ? `<button class="cc-seg-pill ${motionOn ? "is-active" : ""}" data-cameramotion="${id}" aria-pressed="${motionOn}">
                    ${motionOn ? t("移动侦测：开") : t("移动侦测：关")}
                  </button>`
                : ""
            }
          </div>
          ${
            k.availableNightShots.length > 0
              ? `<div class="cc-segmented-pills">
                  ${k.availableNightShots
                    .map(
                      (mode) => `<button class="cc-seg-pill ${k.nightShot === mode ? "is-active" : ""}" data-cameranight="${id}:${this.escapeHtml(mode)}" aria-pressed="${k.nightShot === mode}">
                        ${this.escapeHtml(localizeNightShot(mode))}
                      </button>`
                    )
                    .join("")}
                </div>`
              : ""
          }
        </div>
      `;
    }
    return "";
  }


  private openCameraLiveView(deviceId: string): void {
    const dev = this.devices.find((d) => d.id === deviceId);
    if (!dev || dev.kind.kind !== "camera") return;
    // Hot resume: the modal was only hidden, so the bridge, relay and P2P
    // session are still alive — just reveal it again.
    if (this.activeLiveCameraId === deviceId && this.liveCameraHidden && this.liveCameraImgEl) {
      this.liveCameraHidden = false;
      this.clearCameraKeepAlive();
      invokeTauriVoid("set_pin_popover", { pin: true });
      this.render();
      return;
    }
    if (this.activeLiveCameraId !== null && this.activeLiveCameraId !== deviceId) {
      this.closeCameraLiveView();
    }
    this.activeLiveCameraId = dev.id;
    this.liveCameraHidden = false;
    this.clearCameraKeepAlive();
    this.liveCameraError = null;
    this.liveCameraShowingURLInput = false;
    this.liveCameraStreamURL = this.cameraStreamURLs[dev.id]
      ? this.normalizeWindowsCameraStreamUrl(this.cameraStreamURLs[dev.id]!)
      : null;
    this.liveCameraLoading = false;
    invokeTauriVoid("set_pin_popover", { pin: true });
    if (dev.kind.isOn) {
      if (this.liveCameraStreamURL && this.needsHlsTranscodeBridge(this.liveCameraStreamURL)) {
        void this.bridgeHlsStreamToMjpeg(dev.id, this.liveCameraStreamURL);
      } else if (!this.liveCameraStreamURL && this.settings.connectionMode === "xiaomiCloud") {
        void this.resolveCloudCameraStream(dev);
      }
    }
    this.render();
  }

  /** Hides the modal but keeps the stream hot, so reopening is instant (#97). */
  private hideCameraLiveView(): void {
    if (this.activeLiveCameraId === null) return;
    this.liveCameraHidden = true;
    invokeTauriVoid("set_pin_popover", { pin: false });
    this.clearCameraKeepAlive();
    this.liveCameraKeepAliveTimer = window.setTimeout(() => {
      this.liveCameraKeepAliveTimer = null;
      // Nobody came back within the keep-alive window: release the camera's
      // single P2P session so the phone app (or the next open) can use it.
      if (this.liveCameraHidden) this.closeCameraLiveView();
    }, this.cameraKeepAliveMs);
    this.render();
  }

  private clearCameraKeepAlive(): void {
    if (this.liveCameraKeepAliveTimer !== null) {
      window.clearTimeout(this.liveCameraKeepAliveTimer);
      this.liveCameraKeepAliveTimer = null;
    }
  }

  private closeCameraLiveView(): void {
    const closingId = this.activeLiveCameraId;
    const closingDev = closingId ? this.devices.find((d) => d.id === closingId) : undefined;
    this.clearCameraKeepAlive();
    this.liveCameraHidden = false;
    this.stopLiveTransport();
    this.activeLiveCameraId = null;
    this.liveCameraStreamURL = null;
    this.liveCameraLoading = false;
    this.liveCameraError = null;
    this.liveCameraShowingURLInput = false;
    if (this.settings.connectionMode === "xiaomiCloud" && closingId) {
      if (closingDev) void this.releaseCameraP2PSession(closingDev, this.liveCameraToken);
      // Release the P2P session so the next open negotiates a fresh one instead of a dead relay.
      invokeTauriVoid("stop_xiaomi_camera_bridge", { did: closingId });
    }
    invokeTauriVoid("set_pin_popover", { pin: false });
    this.render();
  }

  /**
   * Tells the camera to drop its single P2P session. Serialized with the next
   * negotiation for the same camera so a delayed stop-stream never kills a
   * freshly reopened stream (#97).
   */
  private releaseCameraP2PSession(dev: SmartDevice, releaseToken = this.liveCameraToken): Promise<void> {
    if (!this.settings.miSession) return Promise.resolve();
    const run = (async () => {
      try {
        const spec = await this.specResolver.resolve({
          did: dev.id,
          name: dev.name,
          model: dev.model,
          isOnline: dev.isOnline,
          specType: null,
        });
        if (this.liveCameraToken !== releaseToken || this.activeLiveCameraId === dev.id) return;
        const p2pSvc = spec.services.find((s) => s.actions.some((a) => a.type.includes("stop-stream")));
        const stopAct = p2pSvc?.actions.find((a) => a.type.includes("stop-stream"));
        if (!p2pSvc || !stopAct) return;
        const client = new MiCloudClient(this.settings.miSession!, this.transport);
        await client
          .callAction({ did: dev.id, siid: p2pSvc.iid, aiid: stopAct.iid, inputs: [] })
          .catch(() => {});
      } catch {
        // Best effort only; the bridge teardown below already freed local resources.
      }
    })();
    const tracked = run.finally(() => {
      if (this.pendingCameraReleases.get(dev.id) === tracked) {
        this.pendingCameraReleases.delete(dev.id);
      }
    });
    this.pendingCameraReleases.set(dev.id, tracked);
    return tracked;
  }

  /** Drops the MJPEG image and any pending negotiation. */
  private stopLiveTransport(): void {
    this.liveCameraToken += 1;
    this.liveCameraImgEl?.remove();
    this.liveCameraImgEl = null;
    this.liveCameraMode = null;
  }

  /** Puts the live element back after `render()` rebuilds the panel markup. */
  private attachLiveMedia(): void {
    const stage = this.root.querySelector<HTMLElement>(".cc-camera-stage");
    if (!stage) return;
    const el = this.liveCameraImgEl;
    if (!el) return;
    if (el.parentElement !== stage) {
      stage.replaceChildren(el);
    }
  }

  private startMjpegTransport(name: string): void {
    const img = document.createElement("img");
    img.id = "cc-camera-live-img";
    img.alt = "";
    img.style.cssText = "max-width:100%;border-radius:10px;";
    let retried = false;
    img.addEventListener("error", () => {
      if (retried) return;
      retried = true;
      window.setTimeout(() => this.reconnectCameraLiveView(), 1200);
    });
    img.src = `http://127.0.0.1:1984/api/stream.mjpeg?src=${encodeURIComponent(name)}`;
    this.liveCameraImgEl = img;
    this.liveCameraMode = "mjpeg";
  }

  /**
   * WebView2/Chromium has no built-in HLS (.m3u8) demuxer. Local go2rtc playlists
   * map directly onto go2rtc's native MJPEG endpoint (`/api/stream.mjpeg`), while
   * remote `.m3u8` playlists are transcoded to MJPEG through `bridge_hls_camera_stream`.
   */
  private normalizeWindowsCameraStreamUrl(rawUrl: string): string {
    return rawUrl
      .trim()
      .replace(
        /^(https?:\/\/(?:127\.0\.0\.1|localhost):1984\/api\/)stream\.m3u8(\?|$)/i,
        "$1stream.mjpeg$2",
      );
  }

  private needsHlsTranscodeBridge(url: string): boolean {
    if (!/\.m3u8(\?|$|#)/i.test(url)) return false;
    const probe = document.createElement("video");
    const canPlayNative =
      typeof probe.canPlayType === "function" &&
      Boolean(
        probe.canPlayType("application/vnd.apple.mpegurl") ||
          probe.canPlayType("application/x-mpegURL"),
      );
    return !canPlayNative && Boolean(window.__TAURI_INTERNALS__?.invoke);
  }

  private async bridgeHlsStreamToMjpeg(did: string, hlsUrl: string): Promise<boolean> {
    if (!window.__TAURI_INTERNALS__?.invoke) return false;
    const token = this.liveCameraToken;
    this.liveCameraLoading = true;
    this.render();
    try {
      const mjpegName = await window.__TAURI_INTERNALS__.invoke<string>("bridge_hls_camera_stream", {
        did,
        hlsUrl,
      });
      if (this.liveCameraToken !== token || this.activeLiveCameraId !== did) return false;
      if (mjpegName) {
        this.liveCameraStreamURL = mjpegName;
        this.liveCameraError = null;
        this.liveCameraLoading = false;
        this.startMjpegTransport(mjpegName);
        this.render();
        this.attachLiveMedia();
        return true;
      }
    } catch (err) {
      if (this.liveCameraToken === token && this.activeLiveCameraId === did) {
        this.liveCameraError = err instanceof Error ? err.message : String(err);
        this.liveCameraLoading = false;
        this.render();
      }
    }
    return false;
  }

  private reconnectCameraLiveView(): void {
    const dev = this.devices.find((d) => d.id === this.activeLiveCameraId);
    if (!dev || dev.kind.kind !== "camera") return;
    this.stopLiveTransport();
    this.liveCameraStreamURL = this.cameraStreamURLs[dev.id]
      ? this.normalizeWindowsCameraStreamUrl(this.cameraStreamURLs[dev.id]!)
      : null;
    this.liveCameraError = null;
    this.liveCameraLoading = false;
    if (this.liveCameraStreamURL && this.needsHlsTranscodeBridge(this.liveCameraStreamURL)) {
      void this.bridgeHlsStreamToMjpeg(dev.id, this.liveCameraStreamURL);
    } else if (!this.liveCameraStreamURL && this.settings.connectionMode === "xiaomiCloud") {
      void this.resolveCloudCameraStream(dev);
    }
    this.render();
  }

  private async resolveCloudCameraStream(dev: SmartDevice): Promise<void> {
    if (dev.kind.kind !== "camera" || !this.settings.miSession) return;
    this.liveCameraLoading = true;
    this.render();
    // Closing/hiding bumps liveCameraToken via stopLiveTransport or full teardown;
    // a negotiation that outlives its modal must not start a bridge afterwards.
    const token = this.liveCameraToken;
    const stale = () => this.liveCameraToken !== token || this.activeLiveCameraId !== dev.id;
    try {
      const pendingRelease = this.pendingCameraReleases.get(dev.id);
      if (pendingRelease) {
        await pendingRelease;
        if (stale()) return;
      }
      const spec = await this.specResolver.resolve({
        did: dev.id,
        name: dev.name,
        model: dev.model,
        isOnline: dev.isOnline,
        specType: null,
      });
      if (stale()) return;
      const client = new MiCloudClient(this.settings.miSession, this.transport);

      // 1. Try cloud HLS action if supported by the model
      const streamSvc =
        spec.services.find((s) =>
          s.actions.some((a) => a.type.includes("start-hls-stream"))
        ) ?? null;
      const act = streamSvc?.actions.find(
        (a) => a.type.includes("start-hls-stream")
      );
      if (streamSvc && act) {
        // macOS parity (MiCloudProvider.resolveCameraStream): the documented action carries
        // typed inputs; try the bare call, then the codec-index variant, and treat every
        // failure as "no cloud HLS" so the P2P bridge below still runs (#97).
        for (const inputs of [[], [1]]) {
          if (stale()) return;
          try {
            const res = await client.callAction({
              did: dev.id,
              siid: streamSvc.iid,
              aiid: act.iid,
              inputs,
            });
            if (stale()) return;
            const rawJson = JSON.stringify(res ?? {});
            const urlMatch = /https?:\/\/[^\s"'\\]+/i.exec(rawJson);
            if (urlMatch?.[0]) {
              const playable = this.normalizeWindowsCameraStreamUrl(urlMatch[0]);
              if (this.needsHlsTranscodeBridge(playable)) {
                if (await this.bridgeHlsStreamToMjpeg(dev.id, playable)) {
                  return;
                }
                // Bridging failed: fall through to P2P below instead of assigning an unplayable .m3u8.
                break;
              }
              if (!/\.m3u8(\?|$|#)/i.test(playable) || !window.__TAURI_INTERNALS__?.invoke) {
                this.liveCameraStreamURL = playable;
                this.liveCameraError = null;
                this.liveCameraLoading = false;
                this.render();
                return;
              }
            }
          } catch {
            // Cloud HLS rejected (bad inputs / 403 / offline): fall back to P2P.
          }
        }
      }

      // 2. Release any previous P2P session, then wake a fresh one (siid=9 p2p-stream service)
      const p2pSvc = spec.services.find((s) =>
        s.actions.some((a) => a.type.includes("start-p2p-stream"))
      );
      const stopAct = p2pSvc?.actions.find((a) => a.type.includes("stop-stream"));
      const p2pAct = p2pSvc?.actions.find((a) => a.type.includes("start-p2p-stream"));
      if (p2pSvc && stopAct) {
        const released = await client
          .callAction({ did: dev.id, siid: p2pSvc.iid, aiid: stopAct.iid, inputs: [] })
          .then(() => true)
          .catch(() => false);
        if (stale()) return;
        // The camera needs a moment to actually free its single P2P session; requesting a
        // new one immediately yields a session that stalls after the first frame (measured
        // 0-14 fps vs 326 fps once the release settles).
        if (released) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
      }
      if (stale()) return;
      if (p2pSvc && p2pAct) {
        await client
          .callAction({ did: dev.id, siid: p2pSvc.iid, aiid: p2pAct.iid, inputs: [] })
          .catch(() => {});
      }
      if (stale()) return;

      // 3. Negotiate MISS CS2/TUTK P2P keys & start native Tauri bridge
      if (window.__TAURI_INTERNALS__?.invoke) {
        const listRes = (await client.request("home/device_list", {
          getVirtualModel: true,
          getHuamiDevices: 1,
          get_split_device: false,
          support_smart_home: true,
        })) as Record<string, unknown> | null;
        if (stale()) return;
        const rawList = Array.isArray(listRes?.["list"]) ? (listRes["list"] as Array<Record<string, unknown>>) : [];
        const rawDev = rawList.find((item) => String(item["did"] ?? "") === dev.id);
        const localIp = typeof rawDev?.["localip"] === "string" ? rawDev["localip"] : "";
        if (localIp) {
          const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
          const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
          const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
          const clientPublic = Array.from(spki.slice(-32)).map((b) => b.toString(16).padStart(2, "0")).join("");
          const clientPrivate = Array.from(pkcs8.slice(-32)).map((b) => b.toString(16).padStart(2, "0")).join("");

          const vendorRes = (await client.request("v2/device/miss_get_vendor", {
            did: dev.id,
            app_pubkey: clientPublic,
            support_vendors: "TUTK_CS2_MTP",
          })) as Record<string, unknown> | null;
          if (stale()) return;
          const vendorObj = (vendorRes?.["vendor"] as Record<string, unknown> | undefined) ?? {};
          const vendorId = Number(vendorObj["vendor"] ?? 4);
          const vendorName = vendorId === 1 ? "tutk" : vendorId === 4 ? "cs2" : String(vendorId);
          const vendorParams = (vendorObj["vendor_params"] as Record<string, unknown> | undefined) ?? {};
          const p2pUid = typeof vendorParams["p2p_id"] === "string" ? vendorParams["p2p_id"] : null;
          const devicePublic = typeof vendorRes?.["public_key"] === "string" ? vendorRes["public_key"] : "";
          const sign = typeof vendorRes?.["sign"] === "string" ? vendorRes["sign"] : "";

          if (devicePublic && sign) {
            if (stale()) return;
            const bridge = await window.__TAURI_INTERNALS__.invoke<string>("start_xiaomi_camera_bridge", {
              did: dev.id,
              model: dev.model,
              localIp,
              clientPublic,
              clientPrivate,
              devicePublic,
              sign,
              vendor: vendorName,
              uid: p2pUid,
            });
            if (stale()) {
              // The close path already tore down once; this late start re-created a
              // relay and stream registrations that nothing else will reclaim. Undo
              // them — unless the same camera was re-opened, in which case the new
              // negotiation's own stop_bridge replaces them and must not be killed.
              if (this.activeLiveCameraId !== dev.id) {
                invokeTauriVoid("stop_xiaomi_camera_bridge", { did: dev.id });
                void this.releaseCameraP2PSession(dev);
              }
              return;
            }
            const [h264Name, mjpegName] = (bridge ?? "").split("|");
            if (mjpegName) {
              this.liveCameraStreamURL = mjpegName;
              this.liveCameraError = null;
              this.liveCameraLoading = false;
              this.startMjpegTransport(mjpegName);
              this.render();
              this.attachLiveMedia();
              return;
            }
            if (h264Name) {
              this.liveCameraStreamURL = h264Name;
              this.liveCameraError = t("实时画面连接失败，请点右上角重新连接");
              this.liveCameraLoading = false;
              this.render();
              return;
            }
          }
        }
      }

      this.liveCameraError = t("米家云直连摄像头采用私有 P2P 加密流；可在下方填写本地 go2rtc / HLS 流地址观看实时画面");
    } catch (err) {
      if (!stale()) {
        this.liveCameraError = err instanceof Error ? err.message : String(err);
      }
    }
    if (stale()) return;
    this.liveCameraLoading = false;
    this.render();
  }

  private renderCameraLiveModal(): string {
    const dev = this.devices.find((d) => d.id === this.activeLiveCameraId);
    if (!dev || dev.kind.kind !== "camera") return "";
    const k = dev.kind;
    const id = this.escapeHtml(dev.id);
    const customURL = this.cameraStreamURLs[dev.id] ?? "";
    const isNight = k.nightShot?.toLowerCase() === "on";
    const motionOn = Boolean(k.isMotionDetectionOn);

    let viewportHtml = "";
    if (!k.isOn) {
      viewportHtml = `
        <div class="cc-camera-stage is-sleeping">
          <strong>${t("摄像机处于物理休眠状态")}</strong>
          <p>${t("镜头已遮蔽，点击下方唤醒后即可查看实时画面")}</p>
          <button class="cc-btn-primary" data-toggle-device="${id}">${t("唤醒镜头并观看")}</button>
        </div>
      `;
    } else if (this.liveCameraMode) {
      // The media element is created once and re-attached here, so polling renders never
      // restart the stream.
      viewportHtml = `<div class="cc-camera-stage" id="cc-camera-stage"></div>`;
    } else if (this.liveCameraLoading) {
      viewportHtml = `
        <div class="cc-camera-stage" style="padding:28px 16px;text-align:center;">
          <strong>${t("正在握手并连接摄像机实时画面…")}</strong>
        </div>
      `;
    } else if (this.liveCameraStreamURL && /^https?:/i.test(this.liveCameraStreamURL)) {
      const safeURL = this.escapeHtml(this.liveCameraStreamURL);
      const isImg = /\.(jpg|jpeg|png)|snapshot|camera_proxy|frame\.jpeg|mjpeg/i.test(this.liveCameraStreamURL);
      viewportHtml = isImg
        ? `<div class="cc-camera-stage"><img id="cc-camera-live-img" src="${safeURL}" alt="${this.escapeHtml(dev.name)}" style="max-width:100%;border-radius:10px;" /></div>`
        : `<div class="cc-camera-stage"><video id="cc-camera-video" src="${safeURL}" controls autoplay muted playsinline preload="auto" style="width:100%;border-radius:10px;background:#090d16;"></video></div>`;
    } else if (this.settings.connectionMode === "demo") {
      viewportHtml = `
        <div class="cc-camera-stage is-demo" style="padding:18px;border-radius:12px;background:${isNight ? "linear-gradient(135deg,#072219,#03110c)" : "linear-gradient(135deg,#10233d,#091224)"};color:#fff;text-align:center;">
          <div style="display:flex;justify-content:space-between;font-size:11px;opacity:0.85;margin-bottom:16px;">
            <span>● ${isNight ? "LIVE · IR NIGHT 2K" : "LIVE · 2K HDR · 25fps"}</span>
            <span>${this.escapeHtml(dev.roomName)}</span>
          </div>
          <div style="padding:20px 8px;">
            <div style="width:36px;height:36px;margin:0 auto 10px;color:${isNight ? "#4ade80" : "#38bdf8"};">${SF_ICONS.videoFill}</div>
            <strong style="display:block;font-size:14px;margin-bottom:4px;">${this.escapeHtml(dev.name)} · ${t("实时看护小窗预览")}</strong>
            <small style="opacity:0.76;">${motionOn ? t("AI 移动与看护侦测中 · 画面正常") : t("实时画面流已就绪 · 窗口已置顶")}</small>
          </div>
        </div>
      `;
    } else {
      viewportHtml = `
        <div class="cc-camera-stage is-error" style="padding:16px;text-align:center;">
          <p style="margin-bottom:10px;">${this.escapeHtml(this.liveCameraError ?? t("可配置本地 go2rtc / HLS 流地址观看实时画面"))}</p>
          <button class="cc-btn-secondary" id="btn-toggle-camera-url">${t("填写 go2rtc / HLS 流地址")}</button>
        </div>
      `;
    }

    return `
      <div class="cc-sheet-backdrop" ${this.liveCameraHidden ? 'style="display:none"' : ""}>
        <div class="cc-sheet cc-camera-live-sheet" role="dialog" aria-modal="true" aria-label="${this.escapeHtml(dev.name)} ${t("实时画面")}">
          <div class="cc-sheet-header">
            <strong>${this.escapeHtml(dev.name)} · ${t("实时画面小窗")}</strong>
            <div style="display:flex;gap:6px;">
              <button class="cc-circle-btn is-small" id="btn-reload-camera-live" title="${t("重新连接")}" aria-label="${t("重新连接")}">${SF_ICONS.arrowClockwise}</button>
              <button class="cc-circle-btn is-small" id="btn-toggle-camera-url" title="${t("配置流地址")}">🔗</button>
              <button class="cc-circle-btn is-small" id="btn-close-camera-live" title="${t("关闭画面")}" aria-label="${t("关闭画面")}">
                ${SF_ICONS.xmark}
              </button>
            </div>
          </div>
          ${
            this.liveCameraShowingURLInput
              ? `<div class="cc-field" style="margin-bottom:10px;">
                  <input id="camera-stream-url-input" class="cc-input" type="text" value="${this.escapeHtml(customURL)}" placeholder="http://127.0.0.1:1984/api/stream.m3u8?src=camera" />
                  <div style="display:flex;gap:6px;margin-top:6px;">
                    <button class="cc-btn-primary" id="btn-save-camera-url">${t("连接流地址")}</button>
                  </div>
                </div>`
              : ""
          }
          ${viewportHtml}
          <div class="cc-segmented-pills" style="margin-top:12px;">
            <button class="cc-seg-pill ${!k.isOn ? "is-active" : ""}" data-toggle-device="${id}" aria-pressed="${!k.isOn}">
              ${k.isOn ? t("镜头休眠") : t("唤醒镜头")}
            </button>
            ${
              k.motionDetectionEntityId
                ? `<button class="cc-seg-pill ${motionOn ? "is-active" : ""}" data-cameramotion="${id}" aria-pressed="${motionOn}">
                    ${motionOn ? t("移动侦测：开") : t("移动侦测：关")}
                  </button>`
                : ""
            }
            ${k.availableNightShots
              .map(
                (mode) => `<button class="cc-seg-pill ${k.nightShot === mode ? "is-active" : ""}" data-cameranight="${id}:${this.escapeHtml(mode)}" aria-pressed="${k.nightShot === mode}">
                  ${this.escapeHtml(localizeNightShot(mode))}
                </button>`
              )
              .join("")}
          </div>
        </div>
      </div>
    `;
  }
  private renderOnboardingModal(): string {
    return `
      <div class="cc-sheet-backdrop">
        <div class="cc-sheet" role="dialog" aria-modal="true" aria-label="${t("首次设置")}">
          <div class="cc-sheet-header">
            <div class="cc-sheet-badge">${t("MenuBarMijia 控制中心")}</div>
            <button class="cc-circle-btn is-small" id="btn-close-onboarding" title="${t("关闭引导")}" aria-label="${t("关闭引导")}">
              ${SF_ICONS.xmark}
            </button>
          </div>

          <h2 class="cc-sheet-title">${t("扫码直连你的真实米家设备")}</h2>
          <p class="cc-sheet-desc">
            ${t("手机打开「米家 App → 扫一扫」即可直接同步全屋真实设备；常驻 Windows 右下角系统托盘，点击图标或按 Alt+M 随时弹出，点击外部自动收起。")}
          </p>

          <div class="cc-field">
            <label>${t("云端服务器地区")}</label>
            <select class="cc-input" data-mi-region>
              ${MI_CLOUD_REGIONS.map(
                (region) => `<option value="${region.code}" ${normalizeMiCloudRegion(this.settings.miCloudRegion) === region.code ? "selected" : ""}>${this.escapeHtml(region.label)}</option>`,
              ).join("")}
            </select>
            <p class="cc-field-hint">${t("欧洲、印度、俄罗斯、新加坡、美区的米家账号请先选择对应地区，再扫码登录。")}</p>
          </div>

          <div class="cc-qr-box">
            <button class="cc-btn-primary is-full" id="btn-start-qr" ${this.isPollingQR ? "disabled" : ""}>
              ${SF_ICONS.qrcode}
              <span>${this.isPollingQR ? t("正在等待手机米家扫码确认...") : t("获取米家登录二维码")}</span>
            </button>
            <div class="cc-qr-status">${this.escapeHtml(this.qrStatusText)}</div>
            ${
              this.qrTicket
                ? `<div class="cc-qr-frame">
                    <img src="${this.escapeHtml(this.qrTicket.qrImageURL)}" alt="Xiaomi QR" />
                  </div>`
                : ""
            }
          </div>

          <div class="cc-sheet-footer">
            <button class="cc-btn-secondary" id="btn-close-onboarding-alt">${t("先看演示预览")}</button>
            <button class="cc-btn-primary" id="btn-finish-onboarding">${t("进入控制中心")}</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderSettingsModal(): string {
    const hiddenIds = new Set(this.hiddenDeviceIds);
    const hiddenDevices = withAliases(this.layout, this.devices.filter((device) => hiddenIds.has(device.id)));
    return `
      <div class="cc-sheet-backdrop">
        <div class="cc-sheet" role="dialog" aria-modal="true" aria-label="${t("偏好设置")}">
          <div class="cc-sheet-header">
            <strong>${t("偏好设置与米家连接")}</strong>
            <button class="cc-circle-btn is-small" id="btn-close-settings" title="${t("返回控制中心")}" aria-label="${t("返回控制中心")}">
              ${SF_ICONS.xmark}
            </button>
          </div>

          <div class="cc-field">
            <label>${t("外观模式")}</label>
            <div class="cc-segmented-pills is-even">
              ${APPEARANCES.map(
                (a) =>
                  `<button class="cc-seg-pill ${this.settings.appearance === a.id ? "is-active" : ""}" data-appearance="${a.id}" aria-pressed="${this.settings.appearance === a.id}">${this.escapeHtml(a.title)}</button>`,
              ).join("")}
            </div>
          </div>

          <div class="cc-field">
            <label>${t("界面语言 / 语言")}</label>
            <div class="cc-segmented-pills">
              ${([["system", t("跟随系统")], ["zh-Hans", t("简体中文")], ["en", "English"]] as const)
                .map(
                  ([value, label]) =>
                    `<button class="cc-seg-pill ${this.settings.interfaceLanguage === value ? "is-active" : ""}" data-interface-language="${value}" aria-pressed="${this.settings.interfaceLanguage === value}">${this.escapeHtml(label)}</button>`,
                )
                .join("")}
            </div>
          </div>

          <div class="cc-field">
            <label>${t("温度单位")}</label>
            <div class="cc-segmented-pills">
              ${([["system", t("跟随系统")], ["celsius", t("摄氏度 (°C)")], ["fahrenheit", t("华氏度 (°F)")]] as const)
                .map(
                  ([value, label]) =>
                    `<button class="cc-seg-pill ${this.settings.temperatureUnit === value ? "is-active" : ""}" data-temperature-unit="${value}" aria-pressed="${this.settings.temperatureUnit === value}">${this.escapeHtml(label)}</button>`,
                )
                .join("")}
            </div>
          </div>

          <div class="cc-field">
            <label>${t("面板大小")}</label>
            <p class="cc-field-hint">${t("拖动左上角调整面板大小")}</p>
            <button type="button" class="cc-btn-secondary" id="btn-reset-panel-size">${t("恢复默认尺寸")}</button>
          </div>

          <div class="cc-field cc-field-row">
            <label for="settings-climate-panel">${t("空调使用整行控制条")}</label>
            <input id="settings-climate-panel" type="checkbox" ${this.settings.climatePanel ? "checked" : ""} />
          </div>

          <div class="cc-field">
            <label class="cc-checkbox">
              <input type="checkbox" id="settings-hide-offline" ${this.layout.hideOfflineDevices === true ? "checked" : ""} />
              <span>${t("隐藏离线设备")}</span>
            </label>
          </div>

          ${hiddenDevices.length > 0 ? `
            <div class="cc-field">
              <label>${t("已隐藏的设备 ({count})", { count: hiddenDevices.length })}</label>
              <div class="cc-timers-stack">
                ${hiddenDevices.map((device) => `
                  <div class="cc-field-row">
                    <span>${this.escapeHtml(device.name)} · ${this.escapeHtml(device.roomName)}</span>
                    <button class="cc-inline-pill" data-unhide-device="${this.escapeHtml(device.id)}">${t("恢复显示")}</button>
                  </div>
                `).join("")}
              </div>
            </div>
          ` : ""}

          <div class="cc-field">
            <div class="cc-field-row">
              <label for="settings-enable-hotkey">${t("启用全局呼出快捷键")}</label>
              <input id="settings-enable-hotkey" type="checkbox" ${this.settings.enableGlobalHotkey ? "checked" : ""} />
            </div>
            ${
              this.settings.enableGlobalHotkey
                ? `<div class="cc-update-row" style="margin-top: 6px;">
                     <span>${t("呼出面板的快捷键")}</span>
                     <div style="display: flex; gap: 6px; align-items: center;">
                       <button
                         type="button"
                         class="cc-seg-pill ${this.isRecordingHotkey ? "is-active" : ""}"
                         id="btn-record-hotkey"
                         title="${t("点击后按下新的组合；Esc 取消")}"
                         aria-pressed="${this.isRecordingHotkey}"
                       >${this.isRecordingHotkey ? t("按下组合…") : this.escapeHtml(this.settings.globalHotkey)}</button>
                       ${
                         this.settings.globalHotkey !== DEFAULT_GLOBAL_SHORTCUT
                           ? `<button type="button" class="cc-btn-secondary" id="btn-reset-hotkey">${t("恢复 Alt+M")}</button>`
                           : ""
                       }
                     </div>
                   </div>`
                : ""
            }
            ${
              this.settings.enableGlobalHotkey && (this.isRecordingHotkey || this.hotkeyNeedsHint)
                ? `<p class="cc-field-hint" id="hotkey-record-hint">${t("需要至少一个 Ctrl / Alt / Shift / Win，或单按 F1–F20。Esc 取消。")}</p>`
                : ""
            }
            ${
              this.settings.enableGlobalHotkey && this.hotkeyRegistrationError
                ? `<div class="cc-update-row" id="hotkey-conflict-row" style="margin-top: 6px;">
                     <span class="cc-field-hint" style="color: #e67e22; margin: 0;">${this.escapeHtml(this.hotkeyRegistrationError)}</span>
                     <button type="button" class="cc-btn-secondary" id="btn-retry-hotkey">${t("重试")}</button>
                   </div>`
                : ""
            }
          </div>

          <div class="cc-field">
            <label>${t("设备数据源")}</label>
            <div class="cc-segmented-pills">
              <button
                class="cc-seg-pill ${this.settings.connectionMode === "xiaomiCloud" ? "is-active" : ""}"
                data-conn-mode="xiaomiCloud"
              >
                米家云真实设备
              </button>
              <button class="cc-seg-pill ${this.settings.connectionMode === "homeAssistant" ? "is-active" : ""}" data-conn-mode="homeAssistant">Home Assistant</button>
              <button
                class="cc-seg-pill ${this.settings.connectionMode === "demo" ? "is-active" : ""}"
                data-conn-mode="demo"
              >
                演示设备预览
              </button>
            </div>
          </div>
          <div class="cc-field">
            <label for="settings-ha-url">Home Assistant URL</label>
            <input id="settings-ha-url" class="cc-input" type="url" value="${this.escapeHtml(this.settings.haBaseURL)}" placeholder="http://homeassistant.local:8123" />
            <label for="settings-ha-token">Home Assistant access token</label>
            <input id="settings-ha-token" class="cc-input" type="password" autocomplete="off" value="${this.escapeHtml(this.settings.haToken)}" />
          </div>

          <div class="cc-field">
            <label>${t("云端服务器地区")}</label>
            <select class="cc-input" data-mi-region>
              ${MI_CLOUD_REGIONS.map(
                (region) => `<option value="${region.code}" ${normalizeMiCloudRegion(this.settings.miCloudRegion) === region.code ? "selected" : ""}>${this.escapeHtml(region.label)}</option>`,
              ).join("")}
            </select>
            <p class="cc-field-hint">当前选择：${this.escapeHtml(miCloudRegionLabel(this.settings.miCloudRegion))}。切换后请重新扫码登录该地区的米家账号；已登录会话仍使用登录时的地区。</p>
          </div>

          <div class="cc-qr-box">
            <button class="cc-btn-primary is-full" id="btn-start-qr" ${this.isPollingQR ? "disabled" : ""}>
              ${SF_ICONS.qrcode}
              <span>
                ${
                  this.settings.miSession
                    ? t("切换/重新扫码 (已登录 {user})", { user: maskedMiUserId(this.settings.miSession.userId) })
                    : t("获取米家登录二维码")
                }
              </span>
            </button>
            <div class="cc-qr-status">${this.escapeHtml(this.qrStatusText)}</div>
            ${
              this.qrTicket
                ? `<div class="cc-qr-frame"><img src="${this.escapeHtml(this.qrTicket.qrImageURL)}" alt="Xiaomi QR" /></div>`
                : ""
            }
          </div>

          <div class="cc-field">
            <label>${t("「全关」包含哪些设备（插座、扫地机默认不包含）")}</label>
            <div class="cc-timers-stack">
              ${this.devices
                .filter((d) => d.kind.kind !== "sensor")
                .map(
                  (d) => `
                <label class="cc-checkbox">
                  <input type="checkbox" data-alloff-device="${this.escapeHtml(d.id)}" ${joinsAllOff(d, this.settings.allOffOverrides) ? "checked" : ""} />
                  <span>${this.escapeHtml(d.name)}${d.roomName ? ` · ${this.escapeHtml(d.roomName)}` : ""}</span>
                </label>`,
                )
                .join("")}
            </div>
          </div>

          <p class="cc-field-hint">${t("Windows 自用版")} · v${APP_VERSION}</p>

          <div class="cc-sheet-footer">
            <button class="cc-btn-danger" id="btn-settings-quit">${t("退出 MenuBarMijia")}</button>
            <button class="cc-btn-primary" id="btn-save-settings">${t("完成并保存")}</button>
          </div>
        </div>
      </div>
    `;
  }

  private bindEvents(): void {
    this.root.querySelector("#btn-device-search")?.addEventListener("click", () => {
      this.setDeviceSearchOpen(!this.isDeviceSearchOpen);
    });
    const search = this.root.querySelector<HTMLInputElement>("#device-search");
    search?.addEventListener("input", (event) => {
      if (!(event as InputEvent).isComposing) this.setDeviceSearch(search.value);
    });
    search?.addEventListener("compositionend", () => this.setDeviceSearch(search.value));

    this.root.querySelector<HTMLElement>("#panel-resize")?.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.panelResize = {
        pointerId: event.pointerId,
        startX: event.screenX,
        startY: event.screenY,
        startWidth: window.innerWidth,
        startHeight: window.innerHeight,
        width: window.innerWidth,
        height: window.innerHeight,
        moved: false,
      };
      this.root.setPointerCapture?.(event.pointerId);
      invokeTauriVoid("set_pin_popover", { pin: true });
    });

    this.root.querySelector("#btn-reset-panel-size")?.addEventListener("click", () => {
      this.settings.panelSize = DEFAULT_PANEL_SIZE;
      writeSettingsForStorage(this.settings);
      this.applyPanelSize();
    });

    this.bindAllOffControl();

    this.root.querySelector("#btn-done-editing")?.addEventListener("click", () => this.stopEditing());

    this.root.querySelector("#btn-home-menu")?.addEventListener("click", () => {
      this.isHomeMenuOpen = !this.isHomeMenuOpen;
      this.render();
    });
    this.root.querySelectorAll<HTMLElement>("[data-home]").forEach((btn) => {
      btn.addEventListener("click", () => this.selectHome(btn.dataset.home || null));
    });
    this.root.querySelectorAll<HTMLElement>("[data-close-menus]").forEach((el) => {
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.isHomeMenuOpen = false;
        this.ctxMenu = null;
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-collapse]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = scopedKey(this.pageKey, btn.dataset.collapse ?? "");
        const set = new Set(this.layout.collapsed);
        if (set.has(key)) set.delete(key); else set.add(key);
        this.layout.collapsed = [...set];
        this.saveLayout();
        this.animateEntrance = !set.has(key);
        this.render();
      });
      btn.addEventListener("contextmenu", (e) => {
        const gid = btn.dataset.groupId;
        if (!gid) return;
        e.preventDefault();
        this.ctxMenu = { x: e.clientX, y: e.clientY, groupId: gid };
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-set-size]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [id, size] = (btn.dataset.setSize ?? "").split(":");
        if (!id || !size) return;
        this.layout.tileSizes[scopedKey(this.pageKey, id)] = size as TileSize;
        this.saveLayout();
        this.ctxMenu = null;
        this.render();
      });
    });
    this.root.querySelectorAll<HTMLElement>("[data-set-group]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const raw = btn.dataset.setGroup ?? "";
        const i = raw.lastIndexOf(":");
        const id = raw.slice(0, i);
        const gid = raw.slice(i + 1);
        if (gid) this.layout.groupMap[id] = gid; else delete this.layout.groupMap[id];
        this.saveLayout();
        this.ctxMenu = null;
        this.render();
      });
    });
    this.root.querySelectorAll<HTMLElement>("[data-new-group]").forEach((btn) => {
      btn.addEventListener("click", () => this.openPrompt({ kind: "newGroup", deviceId: btn.dataset.newGroup ?? "" }));
    });
    this.root.querySelectorAll<HTMLElement>("[data-rename-device]").forEach((btn) => {
      btn.addEventListener("click", () => this.openPrompt({ kind: "renameDevice", deviceId: btn.dataset.renameDevice ?? "" }));
    });
    this.root.querySelectorAll<HTMLElement>("[data-hide-device], [data-unhide-device]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.hideDevice ?? button.dataset.unhideDevice;
        if (id) this.setDeviceHidden(id, button.dataset.hideDevice !== undefined);
      });
    });
    this.root.querySelector<HTMLInputElement>("#settings-hide-offline")?.addEventListener("change", (event) => {
      this.layout.hideOfflineDevices = (event.currentTarget as HTMLInputElement).checked;
      this.saveLayout();
      this.render();
    });
    this.root.querySelector("[data-start-editing]")?.addEventListener("click", () => {
      this.ctxMenu = null;
      this.startEditing();
    });
    this.root.querySelectorAll<HTMLElement>("[data-group-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [action, gid] = (btn.dataset.groupAction ?? "").split(":");
        if (!gid) return;
        this.ctxMenu = null;
        const groups = this.layout.groups;
        const i = groups.findIndex((g) => g.id === gid);
        if (action === "rename") { this.openPrompt({ kind: "renameGroup", groupId: gid }); return; }
        if (action === "up" && i > 0) [groups[i - 1], groups[i]] = [groups[i]!, groups[i - 1]!];
        if (action === "down" && i >= 0 && i < groups.length - 1) [groups[i + 1], groups[i]] = [groups[i]!, groups[i + 1]!];
        if (action === "delete") {
          this.layout.groups = groups.filter((g) => g.id !== gid);
          for (const [d, g] of Object.entries(this.layout.groupMap)) if (g === gid) delete this.layout.groupMap[d];
        }
        this.saveLayout();
        this.render();
      });
    });

    const promptInput = this.root.querySelector<HTMLInputElement>("#prompt-input");
    if (promptInput && document.activeElement !== promptInput) {
      promptInput.focus();
      promptInput.select();
    }
    promptInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.savePrompt(promptInput.value);
      if (e.key === "Escape") { e.stopPropagation(); this.closePrompt(); }
    });
    this.root.querySelector("#btn-prompt-save")?.addEventListener("click", () => this.savePrompt(promptInput?.value ?? ""));
    this.root.querySelector("#btn-prompt-reset")?.addEventListener("click", () => this.savePrompt(""));
    this.root.querySelectorAll<HTMLElement>("[data-prompt-cancel]").forEach((el) => el.addEventListener("click", () => this.closePrompt()));

    this.root.querySelectorAll<HTMLElement>("[data-cycle-size]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const dev = this.devices.find((d) => d.id === btn.dataset.cycleSize);
        if (!dev) return;
        this.layout.tileSizes[scopedKey(this.pageKey, dev.id)] = nextSize(this.tileSize(dev));
        this.saveLayout();
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-acstep]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [id, dir] = (btn.dataset.acstep ?? "").split(":");
        const dev = this.devices.find((d) => d.id === id);
        if (!dev || dev.kind.kind !== "climate") return;
        const k = dev.kind;
        const step = stepCelsius(k.step || 1);
        const next = k.targetTemperature + Number(dir) * step;
        // Round to the thermostat's own step so repeated °F taps do not drift off the °C grid.
        const snapped = Math.round(next / step) * step;
        const temperature = Math.min(k.maxTemp, Math.max(k.minTemp, Number(snapped.toFixed(2))));
        void this.executeSingleCommand(
          dev,
          { kind: "setClimateTemperature", entityId: k.entityId, temperature },
          t("已将{name}设为 {temp}", { name: dev.name, temp: formatTemperature(temperature) }),
        );
      });
    });
    this.root.querySelectorAll<HTMLElement>("[data-acfan]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const raw = btn.dataset.acfan ?? "";
        const i = raw.indexOf(":");
        const dev = this.devices.find((d) => d.id === raw.slice(0, i));
        if (!dev || dev.kind.kind !== "climate") return;
        const fanMode = raw.slice(i + 1);
        void this.executeSingleCommand(
          dev,
          { kind: "setClimateFanMode", entityId: dev.kind.entityId, fanMode },
          t("已将{name}风速设为 {speed}", { name: dev.name, speed: localizeFanMode(fanMode) }),
        );
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-skin]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.settings.skin = btn.dataset.skin as AppSkin;
        this.saveSettings();
        this.render();
      });
    });
    this.root.querySelectorAll<HTMLElement>("[data-appearance]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.appearance;
        this.settings.appearance =
          value === "light" || value === "dark" ? value : "system";
        this.saveSettings();
        this.render();
      });
    });
    this.root.querySelector("#btn-toggle-appearance")?.addEventListener("click", () => {
      this.settings.appearance = this.effectiveAppearance === "light" ? "dark" : "light";
      this.saveSettings();
      this.render();
    });
    this.root.querySelectorAll<HTMLElement>("[data-interface-language]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.interfaceLanguage;
        this.settings.interfaceLanguage =
          value === "zh-Hans" || value === "en" ? value : "system";
        this.applyInterfaceLanguage();
        this.saveSettings();
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-temperature-unit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.temperatureUnit;
        this.settings.temperatureUnit =
          value === "celsius" || value === "fahrenheit" ? value : "system";
        this.applyTemperatureSetting();
        this.saveSettings();
        this.render();
      });
    });

    this.root.querySelector<HTMLInputElement>("#settings-climate-panel")?.addEventListener("change", (e) => {
      this.settings.climatePanel = (e.target as HTMLInputElement).checked;
      this.saveSettings();
      this.render();
    });

    this.root.querySelector<HTMLInputElement>("#settings-enable-hotkey")?.addEventListener("change", (e) => {
      this.settings.enableGlobalHotkey = (e.target as HTMLInputElement).checked;
      this.isRecordingHotkey = false;
      this.hotkeyNeedsHint = false;
      this.saveSettings();
      void this.applyGlobalHotkey();
      this.render();
    });

    this.root.querySelector("#btn-record-hotkey")?.addEventListener("click", () => {
      this.isRecordingHotkey = !this.isRecordingHotkey;
      this.hotkeyNeedsHint = false;
      this.render();
    });

    this.root.querySelector("#btn-reset-hotkey")?.addEventListener("click", () => {
      this.isRecordingHotkey = false;
      this.hotkeyNeedsHint = false;
      this.settings.globalHotkey = DEFAULT_GLOBAL_SHORTCUT;
      this.saveSettings();
      void this.applyGlobalHotkey();
      this.render();
    });

    this.root.querySelector("#btn-retry-hotkey")?.addEventListener("click", () => {
      void this.applyGlobalHotkey();
    });

    this.root.querySelector("#btn-hide-panel")?.addEventListener("click", () => {
      invokeTauriVoid("set_pin_popover", { pin: false });
      invokeTauriVoid("hide_panel");
    });

    this.root.querySelector("#btn-quit-app")?.addEventListener("click", () => {
      invokeTauriVoid("quit_app");
    });

    this.root.querySelector("#btn-settings-quit")?.addEventListener("click", () => {
      invokeTauriVoid("quit_app");
    });

    this.root.querySelector("#btn-toggle-grid")?.addEventListener("click", () => {
      this.settings.isCompactGridMode = !this.settings.isCompactGridMode;
      this.saveSettings();
      this.render();
    });

    this.root.querySelector("#btn-refresh")?.addEventListener("click", () => {
      if (this.settings.connectionMode === "homeAssistant" || this.settings.connectionMode === "xiaomiCloud" && this.settings.miSession) {
        void this.refreshDevices(false);
      } else {
        this.render();
      }
    });

    this.root.querySelector("#btn-footer-qr")?.addEventListener("click", () => {
      this.activeSheet = "settings";
      this.render();
      void this.startXiaomiQRLogin();
    });

    this.root.querySelector("#btn-empty-resync")?.addEventListener("click", () => {
      void this.refreshDevices(false);
    });

    this.root.querySelector("#btn-empty-settings")?.addEventListener("click", () => {
      this.openSettingsSheet();
    });

    this.root.querySelector("#btn-settings")?.addEventListener("click", () => {
      this.openSettingsSheet();
    });

    this.root.querySelector("#btn-undo")?.addEventListener("click", () => {
      void this.performUndo();
    });

    this.root.querySelectorAll<HTMLElement>("[data-quick-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = quickActions().find((item) => item.id === button.dataset.quickAction);
        if (!action) return;
        const intents = this.roomDevices
          .filter((device) => device.isOnline && device.kind.kind === action.deviceKind)
          .filter((device) => device.kind.kind !== "climate" || device.kind.availableModes.includes("cool"))
          .flatMap((device) => action.operations.map((operation) => ({ targetId: device.id, operation })));
        void this.executeIntents(intents, action.title, t("快捷动作"));
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-ha-scene]").forEach((button) => {
      button.addEventListener("click", () => {
        const scene = this.scenes.find((item) => item.id === button.dataset.haScene);
        if (!scene) return;
        const intents: DeviceIntent[] = [{targetId:scene.id,operation:{kind:"activateScene"}}];
        void this.executeIntents(intents, IntentReply.describe(intents, this.devices, this.scenes), t("场景"));
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-room]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.selectedRoom = btn.dataset.room ?? "全部";
        this.animateEntrance = true;
        this.expandedDeviceId = null;
        this.render();
        this.root.querySelector(".cc-room-pill.is-active")?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
      });
    });

    const toggleDeviceById = (id: string) => {
      const dev = this.devices.find((d) => d.id === id);
      if (!dev || dev.kind.kind === "sensor") return;
      const nextOn = !isDeviceActiveOn(dev);
      this.poppedDeviceId = dev.id;
      const cmds = IntentValidator.commandsForIntent(
        { targetId: dev.id, operation: { kind: "power", isOn: nextOn } },
        dev,
      );
      const firstCmd = cmds[0];
      if (firstCmd) {
        void this.executeSingleCommand(
          dev,
          firstCmd,
          `已${nextOn ? t("打开") : t("关闭")}${dev.name}`,
        );
      }
    };

    this.root.querySelectorAll<HTMLElement>("[data-toggle-device]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.toggleDevice;
        if (id) toggleDeviceById(id);
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-body-device]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.bodyDevice;
        if (!id) return;
        const dev = this.devices.find((d) => d.id === id);
        if (!dev) return;
        const k = dev.kind.kind;
        if (k === "camera") {
          if (dev.isOnline && !dev.kind.isOn) {
            toggleDeviceById(id);
          }
          this.openCameraLiveView(id);
        } else if (k === "light" || k === "climate" || k === "fan") {
          this.expandedDeviceId = this.expandedDeviceId === id ? null : id;
          this.render();
        } else {
          toggleDeviceById(id);
        }
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-expand-device]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.expandDevice ?? null;
        this.expandedDeviceId = this.expandedDeviceId === id ? null : id;
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-lighteffect]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const dev = this.devices.find((d) => d.id === btn.dataset.lighteffect);
        const effect = btn.dataset.effect;
        if (!dev || dev.kind.kind !== "light" || !effect) return;
        void this.executeSingleCommand(
          dev,
          { kind: "setLightEffect", entityId: dev.kind.entityId, effect },
          t("已切换{name}灯光模式", { name: dev.name }),
        );
      });
    });

    this.root.querySelectorAll<HTMLInputElement>("[data-brightness]").forEach((slider) => {
      slider.addEventListener("change", () => {
        const id = slider.dataset.brightness;
        if (!id) return;
        const dev = this.devices.find((d) => d.id === id);
        if (!dev || dev.kind.kind !== "light") return;
        const percent = Number(slider.value);
        void this.executeSingleCommand(
          dev,
          { kind: "setLightBrightness", entityId: dev.kind.entityId, percent },
          t("已将{name}亮度设为 {percent}%", { name: dev.name, percent: percent }),
        );
      });
    });

    this.root.querySelectorAll<HTMLInputElement>("[data-colortemp]").forEach((slider) => {
      slider.addEventListener("change", () => {
        const id = slider.dataset.colortemp;
        if (!id) return;
        const dev = this.devices.find((d) => d.id === id);
        if (!dev || dev.kind.kind !== "light") return;
        const kelvin = Number(slider.value);
        void this.executeSingleCommand(
          dev,
          { kind: "setLightColorTemp", entityId: dev.kind.entityId, kelvin },
          t("已将{name}色温设为 {kelvin}K", { name: dev.name, kelvin: kelvin }),
        );
      });
    });

    this.root.querySelectorAll<HTMLInputElement>("[data-actemp]").forEach((slider) => {
      slider.addEventListener("change", () => {
        const id = slider.dataset.actemp;
        if (!id) return;
        const dev = this.devices.find((d) => d.id === id);
        if (!dev || dev.kind.kind !== "climate") return;
        // The slider works in display units; the command carries Celsius (#52).
        const temperature = Number(toCelsius(Number(slider.value)).toFixed(2));
        void this.executeSingleCommand(
          dev,
          { kind: "setClimateTemperature", entityId: dev.kind.entityId, temperature },
          t("已将{name}设为 {temp}", { name: dev.name, temp: formatTemperature(temperature) }),
        );
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-acmode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const raw = btn.dataset.acmode;
        if (!raw) return;
        const [id, hvacMode] = raw.split(":");
        if (!id || !hvacMode) return;
        const dev = this.devices.find((d) => d.id === id);
        if (!dev || dev.kind.kind !== "climate") return;
        void this.executeSingleCommand(
          dev,
          { kind: "setClimateMode", entityId: dev.kind.entityId, hvacMode },
          t("已切换{name}模式", { name: dev.name }),
        );
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-fanpreset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const raw = btn.dataset.fanpreset;
        if (!raw) return;
        const [id, presetMode] = raw.split(":");
        if (!id || !presetMode) return;
        const dev = this.devices.find((d) => d.id === id);
        if (!dev || dev.kind.kind !== "fan") return;
        void this.executeSingleCommand(
          dev,
          { kind: "setFanPresetMode", entityId: dev.kind.entityId, presetMode },
          t("已将{name}设为 {speed}", { name: dev.name, speed: IntentReply.fanSpeedLabel(presetMode) }),
        );
      });
    });

    this.root.querySelectorAll<HTMLInputElement>("[data-fanpercent]").forEach((slider) => {
      slider.addEventListener("change", () => {
        const id = slider.dataset.fanpercent;
        if (!id) return;
        const dev = this.devices.find((d) => d.id === id);
        if (!dev || dev.kind.kind !== "fan") return;
        const percent = Math.max(1, Math.min(100, Math.round(Number(slider.value))));
        void this.executeSingleCommand(
          dev,
          { kind: "setFanPercentage", entityId: dev.kind.entityId, percent },
          t("已将{name}风速设为 {speed}", { name: dev.name, speed: `${percent}%` }),
        );
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-fanosc]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.fanosc;
        if (!id) return;
        const dev = this.devices.find((d) => d.id === id);
        if (!dev || dev.kind.kind !== "fan") return;
        const nextOsc = !dev.kind.isOscillating;
        void this.executeSingleCommand(
          dev,
          { kind: "setFanOscillating", entityId: dev.kind.entityId, oscillating: nextOsc },
          `已${nextOsc ? t("开启") : t("关闭")}${dev.name}摇头`,
        );
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-camera-live]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.cameraLive;
        if (id) this.openCameraLiveView(id);
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-cameramotion]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.cameramotion;
        if (!id) return;
        const dev = this.devices.find((d) => d.id === id);
        if (!dev || dev.kind.kind !== "camera" || !dev.kind.motionDetectionEntityId) return;
        const nextMotion = !dev.kind.isMotionDetectionOn;
        void this.executeSingleCommand(
          dev,
          { kind: "setSwitch", entityId: dev.kind.motionDetectionEntityId, isOn: nextMotion },
          t("已{action}{name}移动侦测", { action: nextMotion ? t("开启") : t("关闭"), name: dev.name }),
        );
      });
    });

    this.root.querySelectorAll<HTMLElement>("[data-cameranight]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const raw = btn.dataset.cameranight;
        if (!raw) return;
        const [id, mode] = raw.split(":");
        if (!id || !mode) return;
        const dev = this.devices.find((d) => d.id === id);
        if (!dev || dev.kind.kind !== "camera") return;
        void this.executeSingleCommand(
          dev,
          { kind: "setSelectOption", entityId: dev.kind.entityId, option: mode },
          t("已将{name}设为{mode}", { name: dev.name, mode: localizeNightShot(mode) }),
        );
      });
    });

    this.root.querySelector("#btn-close-camera-live")?.addEventListener("click", () => {
      this.hideCameraLiveView();
    });

    this.root.querySelector("#btn-reload-camera-live")?.addEventListener("click", () => {
      this.reconnectCameraLiveView();
    });

    this.attachLiveMedia();

    this.root.querySelectorAll<HTMLElement>("#btn-toggle-camera-url").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.liveCameraShowingURLInput = !this.liveCameraShowingURLInput;
        this.render();
      });
    });

    this.root.querySelector("#btn-save-camera-url")?.addEventListener("click", () => {
      const id = this.activeLiveCameraId;
      if (!id) return;
      const input = this.root.querySelector<HTMLInputElement>("#camera-stream-url-input");
      const val = input?.value.trim() ?? "";
      this.stopLiveTransport();
      if (val) {
        const playable = this.normalizeWindowsCameraStreamUrl(val);
        this.cameraStreamURLs[id] = val;
        this.liveCameraStreamURL = playable;
        this.liveCameraError = null;
        this.liveCameraLoading = false;
        const dev = this.devices.find((d) => d.id === id);
        if (dev && dev.kind.kind === "camera" && dev.kind.isOn && this.needsHlsTranscodeBridge(playable)) {
          void this.bridgeHlsStreamToMjpeg(id, playable);
        }
      } else {
        delete this.cameraStreamURLs[id];
        this.liveCameraStreamURL = null;
        const dev = this.devices.find((d) => d.id === id);
        if (dev && dev.kind.kind === "camera" && dev.kind.isOn && this.settings.connectionMode === "xiaomiCloud") {
          void this.resolveCloudCameraStream(dev);
        }
      }
      this.settings.cameraStreamURLs = { ...this.cameraStreamURLs };
      this.saveSettings();
      this.liveCameraShowingURLInput = false;
      this.render();
    });

    this.root.querySelectorAll<HTMLInputElement>("[data-alloff-device]").forEach((box) => {
      box.addEventListener("change", () => {
        const id = box.dataset.alloffDevice ?? "";
        const device = this.devices.find((d) => d.id === id);
        if (!device) return;
        if (box.checked === joinsAllOffByDefault(device)) {
          delete this.settings.allOffOverrides[id];
        } else {
          this.settings.allOffOverrides[id] = box.checked;
        }
        this.saveSettings();
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLSelectElement>("[data-mi-region]").forEach((select) => {
      select.addEventListener("change", () => {
        this.settings.miCloudRegion = normalizeMiCloudRegion(select.value);
        this.saveSettings();
        this.render();
      });
    });

    this.root.querySelector("#btn-start-qr")?.addEventListener("click", () => {
      void this.startXiaomiQRLogin();
    });

    const closeOnboarding = () => {
      this.settings.hasCompletedOnboarding = true;
      this.saveSettings();
      this.activeSheet = "none";
      invokeTauriVoid("set_pin_popover", { pin: false });
      this.render();
    };

    this.root.querySelector("#btn-close-onboarding")?.addEventListener("click", closeOnboarding);
    this.root.querySelector("#btn-close-onboarding-alt")?.addEventListener("click", closeOnboarding);
    this.root.querySelector("#btn-finish-onboarding")?.addEventListener("click", closeOnboarding);

    this.root.querySelector("#btn-close-settings")?.addEventListener("click", () => {
      this.activeSheet = "none";
      this.isRecordingHotkey = false;
      this.hotkeyNeedsHint = false;
      invokeTauriVoid("set_pin_popover", { pin: false });
      this.render();
    });

    this.root.querySelectorAll<HTMLElement>("[data-conn-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.connMode as ConnectionMode | undefined;
        if (!mode) return;
        this.localControlRevision += 1;
        this.invalidateSourceControl();
        this.environmentReadings = [];
        this.homes = [];
        this.replyBanner = null;
        this.settings.connectionMode = mode;
        this.selectedRoom = "全部";
        if (mode === "demo") {
          this.devices = demoDevices();
          this.scenes = demoScenes();
        } else if (mode === "xiaomiCloud") {
          this.devices = structuredClone(this.settings.cachedXiaomiDevices);
          this.scenes = [];
          if (this.settings.miSession) {
            void this.refreshDevices(false);
          }
        } else if (mode === "homeAssistant") {
          const cache = this.settings.cachedHAHome;
          const matches = cache?.identity === homeAssistantIdentity(this.settings.haBaseURL, this.settings.haToken);
          this.devices = matches && cache ? structuredClone(cache.home.devices) : [];
          this.scenes = matches && cache ? structuredClone(cache.home.scenes) : [];
          this.environmentReadings = matches && cache ? structuredClone(cache.home.environmentReadings) : [];
          if (this.settings.haBaseURL && this.settings.haToken) {
            void this.refreshHADevices(false);
          }
        }
        this.saveSettings();
        this.render();
      });
    });

    this.root.querySelector("#btn-save-settings")?.addEventListener("click", () => {
      const haUrl = this.root.querySelector<HTMLInputElement>("#settings-ha-url");
      const haToken = this.root.querySelector<HTMLInputElement>("#settings-ha-token");
      if (haUrl) {
        let endpoint = haUrl.value.trim();
        if (endpoint && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(endpoint)) {
          endpoint = `http://${endpoint}`;
        }
        endpoint = endpoint.replace(/\/api\/websocket\/?$/i, "").replace(/\/+$/, "");
        if (endpoint !== this.settings.haBaseURL) {
          this.invalidateSourceControl();
          this.settings.cachedHAHome = null;
          this.localControlRevision += 1;
          if (this.settings.connectionMode === "homeAssistant") { this.devices = []; this.scenes = []; this.environmentReadings = []; }
        }
        this.settings.haBaseURL = endpoint;
      }
      if (haToken) {
        const token = haToken.value.trim();
        if (token !== this.settings.haToken) {
          this.invalidateSourceControl();
          this.settings.cachedHAHome = null;
          this.localControlRevision += 1;
          if (this.settings.connectionMode === "homeAssistant") { this.devices = []; this.scenes = []; this.environmentReadings = []; }
        }
        this.settings.haToken = token;
      }
      this.saveSettings(true);
      if (this.settings.connectionMode === "homeAssistant") void this.refreshHADevices();
      this.activeSheet = "none";
      this.isRecordingHotkey = false;
      this.hotkeyNeedsHint = false;
      invokeTauriVoid("set_pin_popover", { pin: false });
      this.render();
    });
  }

  // MARK: Layout editing

  private startEditing(): void {
    this.isEditingLayout = true;
    this.expandedDeviceId = null;
    invokeTauriVoid("set_pin_popover", { pin: true });
    this.render();
  }

  private stopEditing(): void {
    this.isEditingLayout = false;
    this.draggingId = null;
    this.dragPointer = null;
    invokeTauriVoid("set_pin_popover", { pin: false });
    this.render();
  }

  private openPrompt(prompt: NonNullable<typeof this.prompt>): void {
    this.ctxMenu = null;
    this.prompt = prompt;
    invokeTauriVoid("set_pin_popover", { pin: true });
    this.render();
  }

  private closePrompt(): void {
    this.prompt = null;
    invokeTauriVoid("set_pin_popover", { pin: this.isEditingLayout });
    this.render();
  }

  private savePrompt(raw: string): void {
    const name = raw.trim();
    const p = this.prompt;
    if (!p) return;
    if (p.kind === "newGroup") {
      if (!name) return;
      const id = `g${Date.now().toString(36)}`;
      this.layout.groups.push({ id, name });
      this.layout.groupMap[p.deviceId] = id;
    } else if (p.kind === "renameGroup") {
      if (!name) return;
      this.layout.groups = this.layout.groups.map((g) => (g.id === p.groupId ? { id: g.id, name } : g));
    } else {
      const original = this.devices.find((d) => d.id === p.deviceId)?.name;
      if (!name || name === original) delete this.layout.aliases[p.deviceId];
      else this.layout.aliases[p.deviceId] = name;
    }
    this.saveLayout();
    this.closePrompt();
  }

  /** Keeps the picked-up card under the pointer; runs after every render. */
  private applyDragOffset(): void {
    if (!this.draggingId || !this.dragPointer) return;
    const el = this.root.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(this.draggingId)}"]`);
    if (!el) return;
    el.style.translate = "0px 0px";
    const r = el.getBoundingClientRect();
    const p = this.dragPointer;
    el.style.translate = `${p.x - p.grabX - r.left}px ${p.y - p.grabY - r.top}px`;
  }

  /** Section of a device on the current page: a user group id or "rest". */
  private sectionOf(id: string): string {
    const g = this.layout.groupMap[id];
    return g && this.layout.groups.some((x) => x.id === g) ? g : "rest";
  }

  /** Before/after the hovered card (top or left half = before); first when above every card. */
  private swapIfNeeded(x: number, y: number): void {
    const dragged = this.draggingId;
    if (!dragged) return;
    const now = performance.now();
    if (this.lastSwap && now - this.lastSwap.at < 250) return;
    const others = Array.from(this.root.querySelectorAll<HTMLElement>("[data-tile-id]"))
      .filter((el) => el.dataset.tileId !== dragged)
      .map((el) => ({ id: el.dataset.tileId as string, r: el.getBoundingClientRect() }));
    if (others.length === 0) return;
    let target: string | null = null;
    let after = false;
    const top = others.reduce((a, b) => (b.r.top < a.r.top ? b : a));
    if (y < top.r.top) {
      target = top.id;
    } else {
      const hit = others.find((o) => x >= o.r.left && x <= o.r.right && y >= o.r.top && y <= o.r.bottom);
      if (!hit) return;
      target = hit.id;
      const r = hit.r;
      after = y < r.top + r.height * 0.3 ? false : y > r.bottom - r.height * 0.3 ? true : x > r.left + r.width / 2;
    }
    const slot = `${target}|${after}`;
    if (this.lastSwap?.slot === slot) return;
    this.lastSwap = { slot, at: now };
    // Dropping beside a card in another group files the dragged card into that group.
    const to = this.sectionOf(target);
    if (to !== this.sectionOf(dragged)) {
      if (to === "rest") delete this.layout.groupMap[dragged]; else this.layout.groupMap[dragged] = to;
    }
    this.layout.order = moveInOrder(this.layout.order, this.devices.map((d) => d.id), dragged, target, after);
    this.saveLayout();
    this.render();
  }

  /**
   * One pointer stream drives tap, long-press-to-edit, drag-to-reorder and drag-to-dim. Listeners
   * live on the persistent root/window, so re-rendering mid-gesture never cancels the drag.
   */
  private bindLayoutGestures(): void {
    let press: { id: string; x: number; y: number; timer: number; dimming: boolean; el: HTMLElement } | null = null;
    let resizing: {
      id: string;
      startX: number;
      startY: number;
      startSize: Exclude<TileSize, "auto">;
      didStep: boolean;
      moved: boolean;
      lastDx: number;
      lastDy: number;
      samples: Array<{ x: number; y: number; t: number }>;
    } | null = null;
    let suppressNextHandleClick = false;

    const endHandleGesture = (id: string): void => {
      const tile = this.root.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(id)}"]`);
      tile?.classList.remove("is-resizing");
      this.root.querySelector<HTMLElement>(".cc-resize-handle.is-active")?.classList.remove("is-active");
    };

    const beginDrag = (id: string, el: HTMLElement, x: number, y: number) => {
      const r = el.getBoundingClientRect();
      this.draggingId = id;
      this.dragPointer = { x, y, grabX: x - r.left, grabY: y - r.top };
      this.lastSwap = null;
      this.suppressNextClick = true;
    };

    this.root.addEventListener(
      "pointerdown",
      () => {
        this.pointerIsDown = true;
      },
      { capture: true },
    );
    window.addEventListener(
      "pointerup",
      () => {
        this.pointerIsDown = false;
      },
      { capture: true },
    );
    window.addEventListener("pointercancel", () => {
      this.pointerIsDown = false;
      if (resizing) { endHandleGesture(resizing.id); resizing = null; }
    });
    window.addEventListener("blur", () => {
      this.pointerIsDown = false;
      if (resizing) { endHandleGesture(resizing.id); resizing = null; }
    });

    this.root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      suppressNextHandleClick = false;
      const handleEl = (e.target as HTMLElement).closest<HTMLElement>(".cc-resize-handle");
      if (handleEl && this.isEditingLayout) {
        const id = handleEl.dataset.resizeHandle ?? handleEl.dataset.cycleSize ?? "";
        const dev = this.devices.find((d) => d.id === id);
        if (dev) {
          resizing = {
            id: dev.id,
            startX: e.clientX,
            startY: e.clientY,
            startSize: this.tileSize(dev),
            didStep: false,
            moved: false,
            lastDx: 0,
            lastDy: 0,
            samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }],
          };
          handleEl.classList.add("is-active");
          handleEl.closest<HTMLElement>("[data-tile-id]")?.classList.add("is-resizing");
        }
        return;
      }
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tile-id]");
      if (!el || (e.target as HTMLElement).closest(".cc-resize-handle, input")) return;
      const id = el.dataset.tileId as string;
      const timer = this.isEditingLayout
        ? 0
        : window.setTimeout(() => {
            if (!press || press.dimming) return;
            beginDrag(id, el, press.x, press.y);
            this.startEditing();
          }, 450);
      press = { id, x: e.clientX, y: e.clientY, timer, dimming: false, el };
    });

    window.addEventListener("pointermove", (e) => {
      if (resizing) {
        const dx = e.clientX - resizing.startX;
        const dy = e.clientY - resizing.startY;
        resizing.lastDx = dx;
        resizing.lastDy = dy;
        const now = performance.now();
        resizing.samples.push({ x: e.clientX, y: e.clientY, t: now });
        resizing.samples = resizing.samples.filter((sample) => now - sample.t <= 120);
        if (Math.hypot(dx, dy) > 3) {
          resizing.moved = true;
        }
        const dev = this.devices.find((d) => d.id === resizing?.id);
        if (!dev) return;
        const next = targetSize(
          resizing.startSize,
          { width: dx, height: dy },
          this.settings.isCompactGridMode,
        );
        if (next !== this.tileSize(dev)) {
          resizing.didStep = true;
          this.layout.tileSizes[scopedKey(this.pageKey, dev.id)] = next;
          this.saveLayout();
          this.render();
        }
        return;
      }
      if (!press) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      const moved = Math.hypot(dx, dy);
      if (this.draggingId) {
        if (this.dragPointer) { this.dragPointer.x = e.clientX; this.dragPointer.y = e.clientY; }
        this.applyDragOffset();
        this.swapIfNeeded(e.clientX, e.clientY);
        return;
      }
      if (this.isEditingLayout) {
        if (moved > 3) {
          beginDrag(press.id, press.el, press.x, press.y);
          this.render();
        }
        return;
      }
      const dev = this.devices.find((d) => d.id === press?.id);
      const isExpanded = dev ? (this.expandedDeviceId === dev.id || this.tileSize(dev) === "panel") : false;
      const canDim = this.skin !== "classic" && !isExpanded && dev?.kind.kind === "light" && dev.isOnline;
      if (!press.dimming && moved > 8) {
        window.clearTimeout(press.timer);
        if (canDim && Math.abs(dx) > Math.abs(dy)) press.dimming = true; else { press = null; return; }
      }
      if (press.dimming) {
        const tile = this.root.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(press.id)}"]`);
        if (!tile) return;
        const r = tile.getBoundingClientRect();
        const percent = Math.max(1, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 100)));
        this.dimPreview = { id: press.id, percent };
        this.suppressNextClick = true;
        this.render();
      }
    });

    window.addEventListener("pointerup", () => {
      if (resizing) {
        const { id, moved, didStep, startSize, samples, lastDx, lastDy } = resizing;
        resizing = null;
        endHandleGesture(id);
        // A drag without a size step leaves the same handle element mounted, so the browser
        // fires a real click on it after pointerup (microtasks run before that click); swallow it.
        if (moved && !didStep) {
          suppressNextHandleClick = true;
          window.setTimeout(() => {
            suppressNextHandleClick = false;
          }, 0);
          // QuotaKeeper-style flick: release velocity projects onto at most one step.
          const projection = projectedOffset(releaseVelocity(samples, performance.now()));
          const dev = this.devices.find((d) => d.id === id);
          if (!dev) return;
          const target = targetSize(
            startSize,
            { width: lastDx + projection.width, height: lastDy + projection.height },
            this.settings.isCompactGridMode,
          );
          if (target !== this.tileSize(dev)) {
            this.layout.tileSizes[scopedKey(this.pageKey, dev.id)] = target;
            this.saveLayout();
            this.render();
          }
        }
        return;
      }
      if (!press) return;
      window.clearTimeout(press.timer);
      const finished = press;
      press = null;
      if (this.draggingId) {
        this.draggingId = null;
        this.dragPointer = null;
        this.render();
        return;
      }
      if (finished.dimming && this.dimPreview) {
        const dev = this.devices.find((d) => d.id === finished.id);
        const percent = this.dimPreview.percent;
        this.dimPreview = null;
        if (dev && dev.kind.kind === "light") {
          void this.executeSingleCommand(dev, { kind: "setLightBrightness", entityId: dev.kind.entityId, percent }, t("已将{name}亮度设为 {percent}%", { name: dev.name, percent: percent }));
        }
      }
    });

    // A long-press or dim drag ends with a click on the card; swallow it so nothing toggles.
    this.root.addEventListener("click", (e) => {
      if (suppressNextHandleClick && (e.target as HTMLElement).closest(".cc-resize-handle")) {
        suppressNextHandleClick = false;
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (this.suppressNextClick || this.isEditingLayout) {
        if ((e.target as HTMLElement).closest("[data-tile-id]") && !(e.target as HTMLElement).closest(".cc-resize-handle")) {
          e.stopPropagation();
          e.preventDefault();
        }
        this.suppressNextClick = false;
      }
    }, true);

    this.root.addEventListener("contextmenu", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tile-id]");
      if (!el) return;
      e.preventDefault();
      this.ctxMenu = { x: e.clientX, y: e.clientY, deviceId: el.dataset.tileId as string };
      this.render();
    });
  }

  /** Drop-in animation each time the tray popover is shown. */
  private bindOpenAnimation(): void {
    const play = () => {
      this.root.classList.remove("is-opening");
      void this.root.offsetWidth;
      this.root.classList.add("is-opening");
      const strip = this.root.querySelector<HTMLElement>(".cc-room-scroll");
      const active = strip?.querySelector<HTMLElement>(".cc-room-pill.is-active");
      if (strip && active) strip.scrollLeft = this.selectedRoom === "全部" ? 0 : active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
    };
    let hiddenAt = 0;
    if (window.__TAURI_INTERNALS__) {
      window.addEventListener("blur", () => { hiddenAt = performance.now(); });
      window.addEventListener("focus", () => { if (performance.now() - hiddenAt > 150) play(); });
    }
    this.root.addEventListener("animationend", (e) => {
      const target = e.target as HTMLElement | null;
      if (target === this.root || target?.classList?.contains("cc-popover")) {
        this.root.classList.remove("is-opening");
      }
    });
    if (typeof window.matchMedia === "function") {
      const mql = window.matchMedia("(prefers-color-scheme: light)");
      mql.addEventListener?.("change", () => {
        if (this.settings.appearance === "system") {
          this.render();
        }
      });
    }
    play();
  }

  private applyPanelSize(): void {
    const legacyHeight = PANEL_HEIGHTS.find((item) => item.id === this.settings.panelHeight)?.px;
    const size = this.settings.panelSize ?? { width: DEFAULT_PANEL_SIZE.width, height: legacyHeight ?? DEFAULT_PANEL_SIZE.height };
    invokeTauriVoid("set_panel_size", { ...size, apply: true });
  }

  private bindPanelResize(): void {
    this.root.addEventListener("pointermove", (event) => {
      const resize = this.panelResize;
      if (!resize || resize.pointerId !== event.pointerId) return;
      resize.width = resize.startWidth + resize.startX - event.screenX;
      resize.height = resize.startHeight + resize.startY - event.screenY;
      resize.moved ||= resize.width !== resize.startWidth || resize.height !== resize.startHeight;
      if (!resize.moved) return;
      if (this.resizeFrame !== undefined) return;
      this.resizeFrame = window.requestAnimationFrame(() => {
        this.resizeFrame = undefined;
        if (this.panelResize === resize) invokeTauriVoid("resize_panel", { width: resize.width, height: resize.height });
      });
    });
    const finish = (event: PointerEvent) => {
      const resize = this.panelResize;
      if (!resize || resize.pointerId !== event.pointerId) return;
      this.panelResize = null;
      if (this.resizeFrame !== undefined) window.cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = undefined;
      void this.saveResizedPanel(resize);
    };
    this.root.addEventListener("pointerup", finish);
    this.root.addEventListener("pointercancel", finish);
    this.root.addEventListener("lostpointercapture", finish);
  }

  private async saveResizedPanel(resize: NonNullable<MenuMijiaWindowsApp["panelResize"]>): Promise<void> {
    try {
      if (!resize.moved) return;
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      const fitted = await invoke?.<[number, number]>("resize_panel", { width: resize.width, height: resize.height });
      const size = storedPanelSize(fitted && { width: fitted[0], height: fitted[1] });
      if (!size) return;
      this.settings.panelSize = size;
      writeSettingsForStorage(this.settings);
      await invoke?.("set_panel_size", { ...size, apply: false });
    } catch (error) {
      console.error("Panel resize failed", error);
    } finally {
      if (this.panelResize === null) invokeTauriVoid("set_pin_popover", { pin: false });
    }
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("app");
  if (root) {
    new MenuMijiaWindowsApp(root);
  }
});
