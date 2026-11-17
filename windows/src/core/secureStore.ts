/**
 * Windows credential store boundary (#28).
 *
 * Secrets never belong in WebView `localStorage`: every process running as the
 * signed-in user can read that file. They live in the Windows Credential
 * Manager through the `secure_store_*` Tauri commands; this module is the only
 * place that knows the credential names and how they map to settings fields.
 *
 * `sanitizeSettingsForStorage` is deliberately pure so tests can prove that a
 * settings object written back to `localStorage` carries no token, key or
 * session. The migration path reads the plaintext copy exactly once, rewrites
 * it without credentials, and moves the values into the credential store; if
 * the store refuses, the app never falls back to writing plaintext.
 */

import { normalizeMiCloudRegion, type MiSession } from "./miCloudClient.js";

export type SecureCredentialName = "mi_session" | "ha_token" | "assistant_api_key";

export interface CredentialSnapshot {
  readonly miSession: MiSession | null;
  readonly haToken: string;
  readonly assistantApiKey: string;
}

export interface CredentialFields {
  readonly miSession?: MiSession | null;
  readonly haToken?: string;
  readonly openRouterApiKey?: string;
}

const CREDENTIAL_SETTINGS_FIELDS = ["miSession", "haToken", "openRouterApiKey"] as const;

export function hasCredentials(credentials: CredentialSnapshot): boolean {
  return credentials.miSession !== null || credentials.haToken !== "" || credentials.assistantApiKey !== "";
}

/**
 * Returns a copy of `settings` without the fields that hold secrets.
 */
export function sanitizeSettingsForStorage<T extends object>(settings: T): Record<string, unknown> {
  const copy = { ...settings } as Record<string, unknown>;
  for (const field of CREDENTIAL_SETTINGS_FIELDS) delete copy[field];
  const cache = copy.cachedHAHome;
  if (cache && typeof cache === "object" && "home" in cache) {
    const home = cache.home;
    if (home && typeof home === "object" && "devices" in home && Array.isArray(home.devices)) {
      copy.cachedHAHome = {
        ...cache,
        home: {
          ...home,
          devices: home.devices.map((device: unknown) => {
            if (!device || typeof device !== "object" || !("kind" in device)) return device;
            const kind = device.kind;
            if (!kind || typeof kind !== "object" || !("kind" in kind) || kind.kind !== "camera") return device;
            return { ...device, kind: { ...kind, snapshotPath: null } };
          }),
        },
      };
    }
  }
  return copy;
}

/** Reads a Mi session from a settings object or from the credential manager's JSON string. */
export function parseMiSession(raw: unknown): MiSession | null {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const stringField = (key: string): string | null => {
    const field = record[key];
    return typeof field === "string" ? field : null;
  };
  const userId = stringField("userId");
  const ssecurity = stringField("ssecurity");
  const serviceToken = stringField("serviceToken");
  if (!userId || !ssecurity || !serviceToken) return null;
  // `passToken` is parsed from old sessions for compatibility but never stored (#27).
  return {
    userId,
    cUserId: stringField("cUserId") ?? "",
    ssecurity,
    serviceToken,
    passToken: "",
    region: normalizeMiCloudRegion(stringField("region")),
  };
}

/** The credential-manager value for `mi_session`: JSON with `passToken` removed (#27). */
export function serializeMiSession(session: MiSession): string {
  return JSON.stringify({
    userId: session.userId,
    cUserId: session.cUserId,
    ssecurity: session.ssecurity,
    serviceToken: session.serviceToken,
    region: session.region,
  });
}

/** Drops the account-level `passToken` as soon as the QR login result reaches the UI. */
export function sessionWithoutPassToken(session: MiSession): MiSession {
  return {
    userId: session.userId,
    cUserId: session.cUserId,
    ssecurity: session.ssecurity,
    serviceToken: session.serviceToken,
    passToken: "",
    region: session.region,
  };
}

export function credentialsFromSettings(settings: CredentialFields): CredentialSnapshot {
  const session = settings.miSession ? parseMiSession(settings.miSession) : null;
  return {
    miSession: session ? sessionWithoutPassToken(session) : null,
    haToken: settings.haToken?.trim() ?? "",
    assistantApiKey: settings.openRouterApiKey?.trim() ?? "",
  };
}

export type SecureInvoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T | null>;

function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T | null> {
  const invoke = typeof window !== "undefined" ? window.__TAURI_INTERNALS__?.invoke : undefined;
  // Browser preview (vite without Tauri) has no credential manager. Treat writes as
  // accepted so the plaintext migration copy is still removed; credentials then live
  // only in memory for that preview session.
  if (!invoke) return Promise.resolve(null);
  return invoke<T>(cmd, args);
}

export async function secureStoreGet(
  name: SecureCredentialName,
  invoke: SecureInvoke = tauriInvoke
): Promise<string | null> {
  const value = await invoke<string | null>("secure_store_get", { name });
  return typeof value === "string" ? value : null;
}

export async function secureStoreSet(
  name: SecureCredentialName,
  value: string,
  invoke: SecureInvoke = tauriInvoke
): Promise<void> {
  await invoke<void>("secure_store_set", { name, value });
}

export async function secureStoreDelete(
  name: SecureCredentialName,
  invoke: SecureInvoke = tauriInvoke
): Promise<void> {
  await invoke<void>("secure_store_delete", { name });
}

/**
 * Writes credentials to the Windows Credential Manager only when they changed.
 * The cache is per instance so a cloud refresh that saves cached devices does
 * not rewrite the credential store every few seconds.
 */
export class CredentialVault {
  private readonly known = new Map<SecureCredentialName, string>();
  private operations: Promise<unknown> = Promise.resolve();
  private readFailed = false;

  constructor(private readonly invoke: SecureInvoke = tauriInvoke) {}

  async load(): Promise<CredentialSnapshot> {
    return this.enqueue(async () => {
      this.readFailed = true;
      const [sessionRaw, haToken, assistantApiKey] = await Promise.all([
        secureStoreGet("mi_session", this.invoke),
        secureStoreGet("ha_token", this.invoke),
        secureStoreGet("assistant_api_key", this.invoke),
      ]);
      const miSession = parseMiSession(sessionRaw);
      if (sessionRaw && !miSession) throw new Error("Saved Xiaomi session could not be parsed");
      const snapshot: CredentialSnapshot = {
        miSession,
        haToken: haToken ?? "",
        assistantApiKey: assistantApiKey ?? "",
      };
      this.remember("mi_session", miSession ? serializeMiSession(miSession) : "");
      this.remember("ha_token", snapshot.haToken);
      this.remember("assistant_api_key", snapshot.assistantApiKey);
      this.readFailed = false;
      return snapshot;
    });
  }

  /** Rejects when the credential manager refused a write; callers must not retry via plaintext. */
  async persist(credentials: CredentialSnapshot): Promise<void> {
    return this.enqueue(async () => {
      if (this.readFailed) throw new Error("Credential store must be read successfully before writing");
      const results = await Promise.allSettled([
        this.sync("mi_session", credentials.miSession ? serializeMiSession(credentials.miSession) : ""),
        this.sync("ha_token", credentials.haToken),
        this.sync("assistant_api_key", credentials.assistantApiKey),
      ]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation);
    this.operations = next.catch(() => undefined);
    return next;
  }

  private remember(name: SecureCredentialName, value: string): void {
    this.known.set(name, value);
  }

  private async sync(name: SecureCredentialName, value: string): Promise<void> {
    if (this.known.get(name) === value) return;
    if (value !== "") {
      await secureStoreSet(name, value, this.invoke);
    } else if (this.known.get(name)) {
      await secureStoreDelete(name, this.invoke);
    }
    this.known.set(name, value);
  }
}
