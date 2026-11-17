import { HomeAssistantClient, HomeAssistantSynthesizer, haServiceCall, homeAssistantCommand, homeAssistantIdentity, parseCachedHAHome } from "../src/core/homeAssistant.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  ASSISTANT_PROVIDER_PRESETS,
  DelayPhrase,
  GROK_BALL_RADIAL_SLOTS,
  LocalIntentParser,
  ModelActionPolicy,
  ModelIntentResolver,
  UndoPhrase,
  UserHabitMemory,
  type HabitDayType,
  assistantEndpointIdentity,
  buildAssistantContext,
  buildHabitSummary,
  buildSystemOneRequestBody,
  buildTimeSummary,
  endpointAllowsSendingSecrets,
  inferAssistantPreset,
  IntentValidator,
  resolveGrokBallEmotion,
} from "../src/core/assistant.js";
import {
  MI_CLOUD_REGIONS,
  MiAccountLogin,
  MiCloudClient,
  MiCloudError,
  MiotCommandMapper,
  MiotSpecResolver,
  MiotSynthesizer,
  inferFallbackSpec,
  maskedMiUserId,
  miApiBaseURL,
  miCloudRegionLabel,
  normalizeMiCloudRegion,
  parseMiotDeviceSpec,
  parseMiotInstanceIndex,
  type MiotDeviceSpec,
} from "../src/core/miCloudClient.js";
import {
  checkForUpdate,
  compareVersions,
  isNewerVersion,
  parseLatestRelease,
  parseUpdateState,
  serializeUpdateState,
  updateCheckDayKey,
} from "../src/core/updateChecker.js";
import { MiCloudCrypto, RC4 } from "../src/core/miCloudCrypto.js";
import {
  CredentialVault,
  credentialsFromSettings,
  parseMiSession,
  sanitizeSettingsForStorage,
  serializeMiSession,
  sessionWithoutPassToken,
  type SecureInvoke,
} from "../src/core/secureStore.js";
import {
  allOffTargets,
  joinsAllOffByDefault,
  partitionDueTimers,
  cloudRefreshDue,
  CLOUD_REFRESH_HIDDEN_MS,
  CLOUD_REFRESH_VISIBLE_MS,
  type DeviceIntent,
  type ScheduledCommand,
  type SmartDevice,
} from "../src/core/models.js";

const Vectors = {
  ssecurity: "AQIDBAUGBwgJCgsMDQ4PEA==",
  nonce: "oLHC0+T1BhcBuoFA",
  signedNonce: "stUjEBQF1H9IaiRGtgWr8jmxbmJs3Xg11OVxJJfJqUI=",
  path: "/home/device_list",
  data: '{"getVirtualModel":true,"getHuamiDevices":1}',
  rc4HashPlain: "+wnR7pbXbANBJTdJEKPTx32/8jc=",
  encData: "zQrgJvr34Xp4b97kO7lmB2GNcU1GhZGWLZUbXNz8fHxrLnNVOUaIiX1/Sl4=",
  encRc4Hash: "nV/pEbnR6lBuW/HKPIJmKEjkG21Mw8aVN5gdFQ==",
  signature: "p4PJO1KloBVLQOZqU31Nl4ZPq4s=",
  respPlain:
    '{"code":0,"message":"ok","result":{"list":[{"did":"123","name":"灯","model":"yeelink.light.ceiling22","isOnline":true}]}}',
  respCipher:
    "zQrkLOrEqjI8Np3lE6VxA2rKaQMWn5+YI9AMTef8cWUgUG0BPEyejn1/IFij2TGz+h6YR3qdIdDNGAZ38HVVeV7I/xFX7t70RZzHM/zsDtMelQgGK0XRgzlsFk4++2JAP/M/aXlqdpyZpKwhzYQ/MJ7bXSF2VIsJkgg=",
};

describe("MiCloudCrypto", () => {
  it("matches classic RC4 vector without drop", () => {
    const rc4 = new RC4(new TextEncoder().encode("Key"), 0);
    const out = rc4.process(new TextEncoder().encode("Plaintext"));
    const hex = Array.from(out)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    assert.equal(hex, "bbf316e8d940af0ad3");
  });

  it("packs 8 random bytes + big-endian minute counter into nonce", () => {
    const nonce = MiCloudCrypto.makeNonce(
      29_000_000 * 60_000,
      [0xa0, 0xb1, 0xc2, 0xd3, 0xe4, 0xf5, 0x06, 0x17]
    );
    assert.equal(nonce, Vectors.nonce);
  });

  it("matches Python reference signed_nonce, rc4_hash__, encrypted fields and signature", () => {
    assert.equal(
      MiCloudCrypto.signedNonce(Vectors.ssecurity, Vectors.nonce),
      Vectors.signedNonce
    );
    assert.equal(
      MiCloudCrypto.sha1Signature(Vectors.path, [["data", Vectors.data]], Vectors.signedNonce),
      Vectors.rc4HashPlain
    );

    const fields = MiCloudCrypto.encryptParams(
      Vectors.path,
      Vectors.data,
      Vectors.ssecurity,
      Vectors.nonce
    );
    assert.deepEqual(
      fields.map(([k]) => k),
      ["data", "rc4_hash__", "signature", "ssecurity", "_nonce"]
    );
    assert.equal(fields[0]?.[1], Vectors.encData);
    assert.equal(fields[1]?.[1], Vectors.encRc4Hash);
    assert.equal(fields[2]?.[1], Vectors.signature);
    assert.equal(fields[3]?.[1], Vectors.ssecurity);
    assert.equal(fields[4]?.[1], Vectors.nonce);
  });

  it("decrypts RC4 response and parses device list", () => {
    const plain = MiCloudCrypto.decryptResponse(Vectors.respCipher, Vectors.signedNonce);
    assert.equal(plain, Vectors.respPlain);

    const result = MiCloudClient.decodeResponse(Vectors.respCipher, 200, Vectors.signedNonce);
    const devices = MiCloudClient.parseDeviceList(result);
    assert.deepEqual(devices, [
      {
        did: "123",
        name: "灯",
        model: "yeelink.light.ceiling22",
        isOnline: true,
        specType: null,
      },
    ]);
  });
});

describe("Xiaomi cloud response failures", () => {
  it("rejects a zero-code signature failure instead of producing an empty list", () => {
    assert.throws(
      () => MiCloudClient.decodeResponse(JSON.stringify({ code: 0, message: "invalid signature" }), 200, Vectors.signedNonce),
      (error: unknown) => error instanceof MiCloudError && error.kind === "badResponse",
    );
  });

  it("recognizes explicit expiry even when the envelope says code zero", () => {
    for (const response of [{ code: 3 }, { code: 0, message: "SERVICETOKEN_EXPIRED" }]) {
      assert.throws(
        () => MiCloudClient.decodeResponse(JSON.stringify(response), 200, Vectors.signedNonce),
        (error: unknown) => error instanceof MiCloudError && error.kind === "sessionExpired",
      );
    }
  });

  it("rejects HTTP failures before trusting a JSON success envelope", () => {
    for (const status of [401, 403, 429, 500, 503]) {
      assert.throws(
        () => MiCloudClient.decodeResponse(Vectors.respPlain, status, Vectors.signedNonce),
        (error: unknown) => error instanceof MiCloudError && error.kind === (status === 401 ? "sessionExpired" : "http"),
      );
    }
  });

  it("distinguishes malformed device lists from a valid empty home", () => {
    for (const value of [null, {}, { list: null }, { list: {} }, { list: [null, {}] }]) {
      assert.throws(() => MiCloudClient.parseDeviceList(value), MiCloudError);
    }
    assert.deepEqual(MiCloudClient.parseDeviceList({ list: [] }), []);
    for (const code of [undefined, null, "0", 0.5]) {
      assert.throws(() => MiCloudClient.unwrapResult({ code, result: { list: [] } }), MiCloudError);
    }
  });
});

describe("Secure credential storage (#28 / #27 / #49)", () => {
  const session = {
    userId: "100",
    cUserId: "abc",
    ssecurity: "ssecurity-value",
    serviceToken: "service-token-value",
    passToken: "account-level-pass-token",
    region: "cn",
  };

  function recordingVault(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    const calls: Array<{ cmd: string; name: string; value?: string }> = [];
    async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T | null> {
      const name = String(args["name"]);
      if (cmd === "secure_store_get") {
        calls.push({ cmd, name });
        return (store.get(name) ?? null) as T | null;
      }
      if (cmd === "secure_store_set") {
        const value = String(args["value"]);
        calls.push({ cmd, name, value });
        store.set(name, value);
        return null;
      }
      calls.push({ cmd, name });
      store.delete(name);
      return null;
    }
    return { vault: new CredentialVault(invoke), calls, store };
  }

  it("strips every credential field before localStorage is written", () => {
    const stored = sanitizeSettingsForStorage({
      connectionMode: "xiaomiCloud",
      miSession: session,
      haToken: "ha-token",
      openRouterApiKey: "sk-live",
      assistantBaseURL: "https://openrouter.ai/api/v1",
    });
    assert.equal(stored["connectionMode"], "xiaomiCloud");
    assert.equal(stored["assistantBaseURL"], "https://openrouter.ai/api/v1");
    assert.equal("miSession" in stored, false);
    assert.equal("haToken" in stored, false);
    assert.equal("openRouterApiKey" in stored, false);
    const json = JSON.stringify(stored);
    assert.equal(json.includes("pass-token"), false);
    assert.equal(json.includes("sk-live"), false);
  });

  it("parses old sessions but never writes passToken back (#27)", () => {
    const old = JSON.stringify(session);
    const parsed = parseMiSession(old);
    assert.equal(parsed?.userId, "100");
    assert.equal(parsed?.passToken, "");
    const storedSession = serializeMiSession(parsed!);
    assert.equal(storedSession.includes("passToken"), false);
    assert.equal(storedSession.includes("account-level-pass-token"), false);
    assert.equal(sessionWithoutPassToken(session).passToken, "");
    assert.equal(credentialsFromSettings({ miSession: session }).miSession?.passToken, "");
  });

  it("writes fixed credential names and deletes cleared ones", async () => {
    const { vault, calls, store } = recordingVault();
    await vault.persist({ miSession: session, haToken: "ha-token", assistantApiKey: "sk-live" });
    assert.deepEqual(
      calls.filter((call) => call.cmd === "secure_store_set").map((call) => call.name).sort(),
      ["assistant_api_key", "ha_token", "mi_session"]
    );
    assert.equal(store.get("mi_session")?.includes("passToken"), false);

    await vault.persist({ miSession: session, haToken: "", assistantApiKey: "" });
    assert.deepEqual(
      calls.filter((call) => call.cmd === "secure_store_delete").map((call) => call.name).sort(),
      ["assistant_api_key", "ha_token"]
    );
    assert.equal(store.has("ha_token"), false);
    assert.equal(store.has("assistant_api_key"), false);
  });

  it("hydrates credentials from the store without rewriting them", async () => {
    const { vault, calls } = recordingVault({
      mi_session: serializeMiSession(session),
      ha_token: "ha-token",
      assistant_api_key: "sk-live",
    });
    const loaded = await vault.load();
    assert.equal(loaded.miSession?.userId, "100");
    assert.equal(loaded.miSession?.passToken, "");
    assert.equal(loaded.haToken, "ha-token");
    assert.equal(loaded.assistantApiKey, "sk-live");

    await vault.persist(loaded);
    assert.equal(calls.some((call) => call.cmd === "secure_store_set"), false);
  });

  it("preserves unread credentials after a partial read failure and allows a later retry", async () => {
    let fail = true;
    const writes: string[] = [];
    const vault = new CredentialVault(async <T>(cmd: string, args: Record<string, unknown>): Promise<T | null> => {
      const name = String(args.name);
      if (cmd !== "secure_store_get") { writes.push(cmd); return null; }
      if (name === "ha_token" && fail) throw new Error("Credential manager temporarily unavailable");
      return (name === "mi_session" ? serializeMiSession(session) : null) as T | null;
    });
    await assert.rejects(vault.load());
    await assert.rejects(vault.persist({ miSession: null, haToken: "", assistantApiKey: "" }));
    assert.deepEqual(writes, []);
    fail = false;
    const loaded = await vault.load();
    assert.equal(loaded.miSession?.userId, session.userId);
    await vault.persist(loaded);
    assert.deepEqual(writes, []);
  });

  it("does not overwrite an unreadable saved session", async () => {
    const { vault, calls, store } = recordingVault({ mi_session: "invalid saved JSON" });
    await assert.rejects(vault.load());
    await assert.rejects(vault.persist({ miSession: null, haToken: "", assistantApiKey: "" }));
    assert.equal(store.get("mi_session"), "invalid saved JSON");
    assert.ok(calls.every((call) => call.cmd === "secure_store_get"));
  });

  it("serializes overlapping saves so an old write cannot replace a new session", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { started = resolve; });
    let saved = "";
    const vault = new CredentialVault(async (cmd, args) => {
      if (cmd === "secure_store_set" && args.name === "mi_session") {
        const value = String(args.value);
        if (value.includes("old-session")) { started(); await gate; }
        saved = value;
      }
      return null;
    });
    const first = vault.persist({ miSession: { ...session, serviceToken: "old-session" }, haToken: "", assistantApiKey: "" });
    await writing;
    const second = vault.persist({ miSession: { ...session, serviceToken: "new-session" }, haToken: "", assistantApiKey: "" });
    release();
    await Promise.all([first, second]);
    assert.equal(parseMiSession(saved)?.serviceToken, "new-session");
  });

  it("uses Web Crypto, not Math.random, for the MIoT nonce (#49)", () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error("Math.random must not be used for security values");
    };
    try {
      const nonce = MiCloudCrypto.makeNonce(29_000_000 * 60_000);
      assert.equal(Buffer.from(nonce, "base64").length, 12);
    } finally {
      Math.random = original;
    }
  });
});

describe("Windows WebView hardening (#29)", () => {
  it("ships a restrictive CSP instead of null", () => {
    const conf = JSON.parse(readFileSync(resolve("src-tauri/tauri.conf.json"), "utf8")) as {
      app: { security: { csp: string | null } };
    };
    const csp = conf.app.security.csp;
    assert.equal(typeof csp, "string");
    assert.match(csp!, /default-src 'self'/);
    assert.match(csp!, /script-src 'self'/);
    assert.doesNotMatch(csp!, /unsafe-eval/);
  });
});

describe("MiAccountLogin", () => {
  it("parses ticket and completes scan flow with Set-Cookie serviceToken", async () => {
    const body =
      '&&&START&&&{"loginUrl":"https://account.xiaomi.com/longPolling/login?ticket=abc","qr":"https://account.xiaomi.com/longPolling/qr?ticket=abc","lp":"https://lp.example/poll","timeout":"30","code":0}';
    const ticket = MiAccountLogin.parseTicket(body);
    assert.equal(ticket.loginURL, "https://account.xiaomi.com/longPolling/login?ticket=abc");
    assert.equal(ticket.timeout, 30);

    let polls = 0;
    const login = new MiAccountLogin(async (req) => {
      if (req.url.startsWith("https://lp.example")) {
        polls += 1;
        if (polls === 1) throw new Error("Request timed out");
        return {
          status: 200,
          headers: {} as Record<string, string>,
          body: '&&&START&&&{"userId":1234567890,"ssecurity":"c3M=","cUserId":"cu","passToken":"pt","location":"https://sts.example/sts?x=1"}',
        };
      }
      if (req.url.startsWith("https://sts.example")) {
        return {
          status: 200,
          headers: { "Set-Cookie": "serviceToken=tok123; path=/; domain=.example" } as Record<string, string>,
          body: "ok",
        };
      }
      return { status: 404, headers: {} as Record<string, string>, body: "" };
    });

    const session = await login.waitForScan(ticket);
    assert.equal(session.userId, "1234567890");
    assert.equal(maskedMiUserId(session.userId), "12****90");
    assert.equal(session.serviceToken, "tok123");
  });
});

describe("MiotSynthesizer & MiotCommandMapper", () => {
  it("does not let a secondary light service claim hood/gateway cards; video-doorbell maps to camera (#98 survey)", () => {
    const hoodSpec: MiotDeviceSpec = {
      type: "urn:miot-spec-v2:device:hood:0000A01B:viomi-c4:1",
      services: [
        {
          iid: 2,
          type: "urn:miot-spec-v2:service:hood:00007825:viomi-c4:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:viomi-c4:1", format: "bool", access: ["read", "write"] },
          ],
          actions: [],
        },
        {
          iid: 6,
          type: "urn:miot-spec-v2:service:light:00007802:viomi-c4:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:viomi-c4:1", format: "bool", access: ["read", "write"] },
          ],
          actions: [],
        },
      ],
    };
    assert.equal(MiotSynthesizer.buildDeviceKind("did_hood", hoodSpec, new Map()), null);

    const ceilingFanSpec: MiotDeviceSpec = {
      type: "urn:miot-spec-v2:device:ceiling-fan:0000A02C:test:1",
      services: [
        {
          iid: 2,
          type: "urn:miot-spec-v2:service:fan:00007808:test:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:test:1", format: "bool", access: ["read", "write"] },
            { iid: 2, type: "urn:miot-spec-v2:property:fan-level:00000016:test:1", format: "uint8", access: ["read", "write"], valueRange: [1, 100, 1] },
          ],
          actions: [],
        },
        {
          iid: 3,
          type: "urn:miot-spec-v2:service:light:00007802:test:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:test:1", format: "bool", access: ["read", "write"] },
          ],
          actions: [],
        },
      ],
    };
    const fanKind = MiotSynthesizer.buildDeviceKind("did_cfan", ceilingFanSpec, new Map());
    assert.equal(fanKind?.kind, "fan");

    const doorbellSpec: MiotDeviceSpec = {
      type: "urn:miot-spec-v2:device:video-doorbell:0000A03A:xiaomi-4pro:1",
      services: [
        {
          iid: 2,
          type: "urn:miot-spec-v2:service:video-doorbell:00007848:xiaomi-4pro:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:xiaomi-4pro:1", format: "bool", access: ["read", "write"] },
            { iid: 3, type: "urn:miot-spec-v2:property:night-shot:00000057:xiaomi-4pro:1", format: "uint8", access: ["read", "write"], valueList: [{ value: 0, description: "Off" }, { value: 2, description: "Auto" }] },
          ],
          actions: [],
        },
      ],
    };
    const doorbellKind = MiotSynthesizer.buildDeviceKind("did_db", doorbellSpec, new Map([["did_db.2.3", 2]]));
    assert.equal(doorbellKind?.kind, "camera");
    if (doorbellKind?.kind === "camera") {
      assert.equal(doorbellKind.nightShot, "Auto");
    }
  });

  it("guards the writable-on fallback against bath-heater lamp services and covers offline fallback specs (#98 survey)", () => {
    // bath-heater has no same-name service, so the same-name guard cannot help; the
    // generic writable-on fallback must still refuse the lamp service.
    const bathHeaterSpec: MiotDeviceSpec = {
      type: "urn:miot-spec-v2:device:bath-heater:0000A028:viomi-v3:1",
      services: [
        {
          iid: 2,
          type: "urn:miot-spec-v2:service:light:00007802:viomi-v3:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:viomi-v3:1", format: "bool", access: ["read", "write"] },
          ],
          actions: [],
        },
        {
          iid: 4,
          type: "urn:miot-spec-v2:service:ptc-bath-heater:00007836:viomi-v3:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:viomi-v3:1", format: "bool", access: ["read", "write"] },
          ],
          actions: [],
        },
      ],
    };
    assert.equal(MiotSynthesizer.buildDeviceKind("did_bh", bathHeaterSpec, new Map()), null);

    // Offline fallback specs (miot-spec.org unreachable) still synthesize the two
    // categories added in #98.
    const purifierFallback = inferFallbackSpec({ model: "zhimi.airp.rma3", name: "空气净化器" });
    const purifierKind = MiotSynthesizer.buildDeviceKind(
      "did_fb_airp",
      purifierFallback,
      new Map<string, unknown>([["did_fb_airp.2.1", true], ["did_fb_airp.3.4", 18]]),
    );
    assert.equal(purifierKind?.kind, "fan");
    if (purifierKind?.kind === "fan") {
      assert.equal(purifierKind.pm25Density, 18);
      assert.deepEqual(purifierKind.availablePresetModes, ["Auto", "Sleep", "Favorite"]);
    }

    const cameraFallback = inferFallbackSpec({ model: "chuangmi.camera.061a01", name: "摄像机" });
    const cameraKind = MiotSynthesizer.buildDeviceKind(
      "did_fb_cam",
      cameraFallback,
      new Map<string, unknown>([["did_fb_cam.2.1", true]]),
    );
    assert.equal(cameraKind?.kind, "camera");
  });

  const lightSpec: MiotDeviceSpec = {
    type: "urn:miot-spec-v2:device:light:0000A001:yeelink-ceiling22:1",
    services: [
      {
        iid: 2,
        type: "urn:miot-spec-v2:service:light:00007802:yeelink-ceiling22:1",
        properties: [
          { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:yeelink-ceiling22:1", format: "bool", access: ["read", "write"] },
          { iid: 2, type: "urn:miot-spec-v2:property:brightness:0000000D:yeelink-ceiling22:1", format: "uint8", access: ["read", "write"], valueRange: [1, 100, 1] },
          {
            iid: 3,
            type: "urn:miot-spec-v2:property:mode:00000008:yeelink-ceiling22:1",
            format: "uint8",
            access: ["read", "write"],
            valueList: [
              { value: 0, description: "Day" },
              { value: 1, description: "Night" },
            ],
          },
        ],
        actions: [],
      },
    ],
  };

  it("synthesizes a light and maps Moonlight effect to MiotPropWrite", () => {
    const home = MiotSynthesizer.synthesize(
      [{ did: "did1", name: "书房吸顶灯", model: "yeelink.light.ceiling22", isOnline: true, specType: null }],
      [{ id: "r1", name: "书房", dids: ["did1"] }],
      { "yeelink.light.ceiling22": lightSpec },
      new Map<string, unknown>([
        ["did1.2.1", true],
        ["did1.2.2", 80],
        ["did1.2.3", 0],
      ])
    );
    assert.equal(home.devices.length, 1);
    const dev = home.devices[0]!;
    assert.equal(dev.kind.kind, "light");
    assert.deepEqual(dev.kind.availableEffects, ["Day", "Night"]);

    const write = MiotCommandMapper.map(
      { kind: "setLightEffect", entityId: "miot:did1:2", effect: "Night" },
      lightSpec
    );
    assert.deepEqual(write, {
      kind: "setProps",
      writes: [
        { did: "did1", siid: 2, piid: 1, value: true },
        { did: "did1", siid: 2, piid: 3, value: 1 },
      ],
    });
  });

  it("resolves Xiaomi devices with null specType via instances index and normalizes kebab-case value-range/value-list", async () => {
    const rawMiotSpecJson = {
      type: "urn:miot-spec-v2:device:air-conditioner:0000A004:xiaomi-mc5:2",
      services: [
        {
          iid: 2,
          type: "urn:miot-spec-v2:service:air-conditioner:0000780F:xiaomi-mc5:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:xiaomi-mc5:1", format: "bool", access: ["read", "write"] },
            {
              iid: 2,
              type: "urn:miot-spec-v2:property:mode:00000008:xiaomi-mc5:1",
              format: "uint8",
              access: ["read", "write"],
              "value-list": [
                { value: 2, description: "Cool" },
                { value: 5, description: "Heat" },
              ],
            },
            {
              iid: 4,
              type: "urn:miot-spec-v2:property:target-temperature:00000021:xiaomi-mc5:1",
              format: "float",
              access: ["read", "write"],
              "value-range": [16, 31, 0.5],
            },
          ],
        },
      ],
    };

    const parsedSpec = parseMiotDeviceSpec(rawMiotSpecJson);
    assert.ok(parsedSpec);
    assert.deepEqual(parsedSpec.services[0]?.properties[2]?.valueRange, [16, 31, 0.5]);
    assert.equal(parsedSpec.services[0]?.properties[1]?.valueList?.[0]?.description, "Cool");

    const idx = parseMiotInstanceIndex({
      instances: [
        { model: "xiaomi.aircondition.mc5", version: 1, type: "urn:old" },
        { model: "xiaomi.aircondition.mc5", version: 2, type: rawMiotSpecJson.type },
      ],
    });
    assert.equal(idx["xiaomi.aircondition.mc5"], rawMiotSpecJson.type);

    const resolver = new MiotSpecResolver(async (req) => {
      if (req.url.includes("/instances?status=released")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            instances: [{ model: "xiaomi.aircondition.mc5", version: 2, type: rawMiotSpecJson.type }],
          }),
        };
      }
      if (req.url.includes("/instance?type=")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(rawMiotSpecJson),
        };
      }
      return { status: 404, headers: {}, body: "" };
    });

    const rawDevices = [
      { did: "ac1", name: "主卧空调", model: "xiaomi.aircondition.mc5", isOnline: true, specType: null },
      { did: "plug1", name: "书房插座", model: "unknown.brand.socket1", isOnline: true, specType: null },
    ];
    const resolvedSpecs = await resolver.resolveForDevices(rawDevices);
    const home = MiotSynthesizer.synthesize(
      rawDevices,
      [{ id: "r_bed", name: "主卧", dids: ["ac1"] }],
      resolvedSpecs,
      new Map<string, unknown>([
        ["ac1.2.1", true],
        ["ac1.2.2", 2],
        ["ac1.2.4", 24.5],
        ["plug1.2.1", true],
      ])
    );

    assert.equal(home.devices.length, 2);
    assert.equal(home.devices[0]?.kind.kind, "climate");
    assert.equal(home.devices[0]?.kind.targetTemperature, 24.5);
    assert.equal(home.devices[1]?.kind.kind, "plug");
    assert.equal(home.devices[1]?.kind.isOn, true);
  });

  it("maps MIoT plug power-consumption with explicit scale in unit or comment into energyKwh", () => {
    const spec = parseMiotDeviceSpec({
      type: "urn:miot-spec-v2:device:outlet:0000A002:unit-plug:1",
      services: [
        {
          iid: 2,
          type: "urn:miot-spec-v2:service:switch:0000780C:unit-plug:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:unit-plug:1", format: "bool", access: ["read", "write"] },
          ],
        },
        {
          iid: 3,
          type: "urn:miot-spec-v2:service:power-consumption:0000780E:unit-plug:1",
          properties: [
            {
              iid: 1,
              type: "urn:miot-spec-v2:property:power-consumption:0000002F:unit-plug:1",
              format: "uint32",
              access: ["read"],
              unit: "0.01kWh",
            },
          ],
        },
      ],
    });
    assert.ok(spec);
    const home = MiotSynthesizer.synthesize(
      [{ did: "p_unit", name: "插座", model: "unit.plug", isOnline: true, specType: null }],
      [],
      { "unit.plug": spec },
      new Map<string, unknown>([
        ["p_unit.2.1", true],
        ["p_unit.3.1", 512],
      ])
    );
    assert.equal(home.devices[0]?.kind.kind, "plug");
    if (home.devices[0]?.kind.kind === "plug") {
      assert.equal(home.devices[0].kind.energyKwh, 5.12);
    }

    const unsupportedDeciSpec = parseMiotDeviceSpec({
      type: "urn:miot-spec-v2:device:outlet:0000A002:deci-plug:1",
      services: [
        {
          iid: 2,
          type: "urn:miot-spec-v2:service:switch:0000780C:deci-plug:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:deci-plug:1", format: "bool", access: ["read", "write"] },
          ],
        },
        {
          iid: 3,
          type: "urn:miot-spec-v2:service:power-consumption:0000780E:deci-plug:1",
          properties: [
            {
              iid: 1,
              type: "urn:miot-spec-v2:property:power-consumption:0000002F:deci-plug:1",
              format: "uint32",
              access: ["read"],
              unit: "0.1kWh",
              comment: "单位:0.1kWh",
            },
          ],
        },
      ],
    });
    assert.ok(unsupportedDeciSpec);
    const deciHome = MiotSynthesizer.synthesize(
      [{ did: "p_deci", name: "插座", model: "deci.plug", isOnline: true, specType: null }],
      [],
      { "deci.plug": unsupportedDeciSpec },
      new Map<string, unknown>([
        ["p_deci.2.1", true],
        ["p_deci.3.1", 512],
      ])
    );
    assert.equal(deciHome.devices[0]?.kind.kind, "plug");
    if (deciHome.devices[0]?.kind.kind === "plug") {
      assert.equal(deciHome.devices[0].kind.energyKwh, undefined);
    }
  });

  it("matches the cross-platform MIoT golden JSON corpus shared with MijiaCoreTests", () => {
    const raw = readFileSync(resolve(process.cwd(), "../Tests/Fixtures/miot_golden.json"), "utf8");
    const corpus = JSON.parse(raw) as {
      specs: Record<string, unknown>;
      devices: Array<{
        did: string;
        name: string;
        model: string;
        isOnline: boolean;
        splitParentDid?: string | null;
        splitSiid?: number | null;
      }>;
      rooms: Array<{ id: string; name: string; dids: string[] }>;
      values: Array<{ did: string; siid: number; piid: number; value: unknown }>;
      expectedKinds: Record<string, unknown>;
      expectedEnvironmentReadings: Array<unknown>;
      expectedRequiredProps: Record<string, Array<{ did: string; siid: number; piid: number }>>;
      commandCases: Array<{
        model: string;
        command: Parameters<typeof MiotCommandMapper.map>[0];
        expected: ReturnType<typeof MiotCommandMapper.map>;
      }>;
      fallbackSpecs: Array<{
        did: string;
        model: string;
        name: string;
        spec: unknown;
        values: Array<{ siid: number; piid: number; value: unknown }>;
        expectedKind: unknown;
      }>;
    };

    const parsedSpecs: Record<string, MiotDeviceSpec> = {};
    for (const [model, rawSpec] of Object.entries(corpus.specs)) {
      const parsed = parseMiotDeviceSpec(rawSpec);
      assert.ok(parsed, `Failed to parse MIoT spec for ${model}`);
      parsedSpecs[model] = parsed;
    }

    const records = corpus.devices.map((d) => ({
      ...d,
      specType: null,
    }));
    const values = new Map<string, unknown>();
    for (const v of corpus.values) {
      values.set(`${v.did}.${v.siid}.${v.piid}`, v.value);
    }

    const home = MiotSynthesizer.synthesize(records, corpus.rooms, parsedSpecs, values);
    assert.equal(home.devices.length, Object.keys(corpus.expectedKinds).length);
    for (const [did, expectedKind] of Object.entries(corpus.expectedKinds)) {
      const dev = home.devices.find((d) => d.id === did);
      assert.ok(dev, `Missing synthesized device ${did}`);
      assert.deepEqual(dev.kind, expectedKind, `DeviceKind mismatch on ${did}`);
    }
    assert.deepEqual(home.environmentReadings, corpus.expectedEnvironmentReadings);

    // Offline climate/fan/sensor devices must not enter environmentReadings (#103).
    const offlineHome = MiotSynthesizer.synthesize(
      records.map((r) => ({ ...r, isOnline: false })),
      corpus.rooms,
      parsedSpecs,
      values,
    );
    assert.deepEqual(offlineHome.environmentReadings, []);

    for (const record of records) {
      const spec = parsedSpecs[record.model];
      assert.ok(spec, `Missing spec for ${record.model}`);
      const actualProps = MiotSynthesizer.requiredProps(record, spec);
      assert.deepEqual(actualProps, corpus.expectedRequiredProps[record.did], `requiredProps mismatch on ${record.did}`);
    }

    for (const item of corpus.commandCases) {
      const spec = parsedSpecs[item.model];
      assert.ok(spec, `Missing spec for ${item.model}`);
      const actualWrite = MiotCommandMapper.map(item.command, spec);
      assert.deepEqual(actualWrite, item.expected, `${item.model} ${item.command.kind}`);
    }
    const dev2 = home.devices.find((d) => d.id === "did_panel.s2");
    assert.equal(dev2?.roomName, "客厅");

    // Offline fallback specs are shared synthesis rules: the corpus pins the exact
    // spec inferFallbackSpec must produce, and both platforms assert synthesis (#98).
    for (const entry of corpus.fallbackSpecs) {
      const parsedFallback = parseMiotDeviceSpec(entry.spec);
      assert.ok(parsedFallback, `Failed to parse fallback spec for ${entry.model}`);
      assert.deepEqual(
        inferFallbackSpec({ model: entry.model, name: entry.name }),
        parsedFallback,
        `fallback spec drift for ${entry.model}`,
      );
      const fallbackHome = MiotSynthesizer.synthesize(
        [{ did: entry.did, name: entry.name, model: entry.model, isOnline: true, specType: null }],
        [],
        { [entry.model]: parsedFallback },
        new Map(entry.values.map((v) => [`${entry.did}.${v.siid}.${v.piid}`, v.value])),
      );
      const fallbackDev = fallbackHome.devices.find((d) => d.id === entry.did);
      assert.ok(fallbackDev, `Missing fallback device ${entry.model}`);
      assert.deepEqual(fallbackDev.kind, entry.expectedKind, `fallback kind mismatch on ${entry.model}`);
    }
  });

  it("parses split Mesh switch keys and multi-home rooms with room-less home dids", () => {
    const parsedDevices = MiCloudClient.parseDeviceList({
      list: [
        { did: "1109223163", name: "Mesh双键", model: "lemesh.switch.sw2f12", isOnline: true },
        {
          did: "1109223163.s2",
          name: "筒灯",
          model: "lemesh.switch.sw2f12",
          isOnline: true,
          extra: { split: { parentId: 1109223163, moduleId: 2 } },
        },
      ],
    });
    assert.equal(parsedDevices.length, 2);
    assert.equal(parsedDevices[1]?.splitParentDid, "1109223163");
    assert.equal(parsedDevices[1]?.splitSiid, 2);

    const parsedRooms = MiCloudClient.parseRooms({
      homelist: [
        {
          id: 9001,
          name: "我的家",
          dids: ["unassigned_did"],
          roomlist: [{ id: 101, name: "客厅", dids: ["1109223163"] }],
        },
      ],
    });
    assert.deepEqual(parsedRooms, [
      { id: "101", name: "客厅", dids: ["1109223163"], homeId: "9001", homeName: "我的家" },
      { id: "home_9001", name: "", dids: ["unassigned_did"], homeId: "9001", homeName: "我的家" },
    ]);
  });

  it("maps explicit MIoT kWh, 0.01kWh, and Wh cumulative counters while ignoring untagged integers (#62)", () => {
    const makeSpec = (energyProp: Record<string, unknown>): MiotDeviceSpec => {
      const parsed = parseMiotDeviceSpec({
        type: "urn:miot-spec-v2:device:outlet:0000A002:test-plug:1",
        services: [
          {
            iid: 2,
            type: "urn:miot-spec-v2:service:switch:0000780C:test-plug:1",
            properties: [{ iid: 1, type: "urn:miot-spec-v2:property:on:00000006:test-plug:1", format: "bool", access: ["read", "write"] }],
            actions: [],
          },
          {
            iid: 3,
            type: "urn:miot-spec-v2:service:power-consumption:0000780E:test-plug:1",
            properties: [
              { iid: 1, type: "urn:miot-spec-v2:property:electric-power:00000066:test-plug:1", format: "float", access: ["read"] },
              energyProp,
            ],
            actions: [],
          },
        ],
      });
      assert.ok(parsed);
      return parsed;
    };

    const specs: Record<string, MiotDeviceSpec> = {
      "test.plug.kwh": makeSpec({
        iid: 2,
        type: "urn:miot-spec-v2:property:power-consumption:0000002F:test-plug:1",
        format: "float",
        access: ["read"],
        unit: "kWh",
      }),
      "test.plug.centi": makeSpec({
        iid: 2,
        type: "urn:miot-spec-v2:property:power-consumption:0000002F:test-plug:1",
        format: "uint16",
        access: ["read"],
        comment: "耗电量（单位:0,01Kwh）",
      }),
      "test.plug.wh": makeSpec({
        iid: 2,
        type: "urn:miot-spec-v2:property:power-consumption:0000002F:test-plug:1",
        format: "uint32",
        access: ["read"],
        unit: "Wh",
      }),
      "test.plug.untagged": makeSpec({
        iid: 2,
        type: "urn:miot-spec-v2:property:power-consumption:0000002F:test-plug:1",
        format: "uint32",
        access: ["read"],
        unit: "none",
      }),
    };

    const records = [
      { did: "p_kwh", name: "直读插座", model: "test.plug.kwh", isOnline: true, specType: null },
      { did: "p_centi", name: "百分度插座", model: "test.plug.centi", isOnline: true, specType: null },
      { did: "p_wh", name: "瓦时插座", model: "test.plug.wh", isOnline: true, specType: null },
      { did: "p_untagged", name: "无单位插座", model: "test.plug.untagged", isOnline: true, specType: null },
    ];
    const values = new Map<string, unknown>([
      ["p_kwh.2.1", true],
      ["p_kwh.3.1", 40],
      ["p_kwh.3.2", 12.34],
      ["p_centi.2.1", true],
      ["p_centi.3.1", 55],
      ["p_centi.3.2", 250],
      ["p_wh.2.1", true],
      ["p_wh.3.1", 10],
      ["p_wh.3.2", 1500],
      ["p_untagged.2.1", true],
      ["p_untagged.3.1", 20],
      ["p_untagged.3.2", 500],
    ]);

    const home = MiotSynthesizer.synthesize(records, [], specs, values);
    const byId = new Map(home.devices.map((d) => [d.id, d.kind]));
    const plugEnergy = (id: string) => {
      const k = byId.get(id);
      return k?.kind === "plug" ? k.energyKwh : undefined;
    };
    assert.equal(plugEnergy("p_kwh"), 12.34);
    assert.equal(plugEnergy("p_centi"), 2.5);
    assert.equal(plugEnergy("p_wh"), 1.5);
    assert.equal(plugEnergy("p_untagged"), undefined);

    const untaggedProps = MiotSynthesizer.requiredProps(records[3]!, specs["test.plug.untagged"]!);
    assert.equal(untaggedProps.some((p) => p.siid === 3 && p.piid === 2), false);
  });
});

describe("LocalIntentParser, DelayPhrase, UndoPhrase, and ModelIntentResolver", () => {
  const devices: SmartDevice[] = [
    {
      id: "dev_ceiling",
      name: "书房吸顶灯",
      roomId: "study",
      roomName: "书房",
      model: "yeelink.light.ceiling20",
      isOnline: true,
      kind: {
        kind: "light",
        entityId: "miot:dev_ceiling:2",
        isOn: true,
        brightnessPercent: 80,
        colorTempKelvin: 4000,
        minKelvin: 2700,
        maxKelvin: 6500,
        currentEffect: "Day",
        availableEffects: ["Day", "Night"],
      },
    },
    {
      id: "dev_desk",
      name: "书房台灯",
      roomId: "study",
      roomName: "书房",
      model: "yeelink.light.lamp4",
      isOnline: true,
      kind: {
        kind: "light",
        entityId: "miot:dev_desk:2",
        isOn: true,
        brightnessPercent: 50,
        colorTempKelvin: 4000,
        minKelvin: 2700,
        maxKelvin: 6500,
        currentEffect: null,
        availableEffects: [],
      },
    },
    {
      id: "dev_fan",
      name: "客厅风扇",
      roomId: "living",
      roomName: "客厅",
      model: "dmaker.fan.p5",
      isOnline: true,
      kind: {
        kind: "fan",
        entityId: "miot:dev_fan:2",
        isOn: true,
        percentage: null,
        presetMode: "Level1",
        availablePresetModes: ["Level1", "Level2", "Level3"],
        isOscillating: false,
      },
    },
  ];

  it("parses moonlight effect, multi-light relative dimming, fan speed, delay, and undo", () => {
    const moon = LocalIntentParser.parse("书房灯月光模式", devices, []);
    assert.ok(moon);
    assert.deepEqual(moon.intents, [
      { targetId: "dev_ceiling", operation: { kind: "lightEffect", effect: "Night" } },
    ]);

    const dimmer = LocalIntentParser.parse("再暗一点", devices, []);
    assert.ok(dimmer);
    assert.deepEqual(dimmer.intents, [
      { targetId: "dev_ceiling", operation: { kind: "brightness", percent: 60 } },
      { targetId: "dev_desk", operation: { kind: "brightness", percent: 30 } },
    ]);

    const fanHigh = LocalIntentParser.parse("风扇调到高档", devices, []);
    assert.ok(fanHigh);
    assert.deepEqual(fanHigh.intents, [
      { targetId: "dev_fan", operation: { kind: "fanSpeed", speed: "Level3" } },
    ]);

    const delay = DelayPhrase.extract("10分钟后关闭书房灯");
    assert.deepEqual(delay, { seconds: 600, remainder: "关闭书房灯" });
    assert.equal(DelayPhrase.isCancel("取消定时"), true);
    assert.equal(UndoPhrase.isUndo("刚才那个撤销"), true);
  });

  it("resolves Jev /v1/systemone multi-choice payload", async () => {
    const resolver = new ModelIntentResolver(
      {
        baseURL: "https://openrouter.ai/api/v1",
        model: "typesafe/jev-latest",
        apiKey: "test-key",
      },
      async (req) => {
        assert.equal(req.url, "https://openrouter.ai/api/v1/systemone");
        const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
        assert.equal(body["model"], "~typesafe/jev-latest");
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            answers: {
              target: { choice: "room_lights:书房", confidence: 0.98 },
              op: { choice: "effect_night", confidence: 0.96 },
              temp: { choice: "none", confidence: 0.99 },
            },
          }),
        };
      }
    );

    const plan = await resolver.resolve("书房来点柔和月光", devices, []);
    assert.equal(plan.source, "model");
    assert.deepEqual(plan.intents, [
      { targetId: "dev_ceiling", operation: { kind: "lightEffect", effect: "Night" } },
    ]);
  });

  it("supports native TypeSafe Jev (/v1/systemone) and DeepSeek (/v1/chat/completions)", async () => {
    assert.deepEqual(
      ASSISTANT_PROVIDER_PRESETS.map((p) => p.id),
      [
        "openrouter_jev",
        "native_jev",
        "deepseek",
        "siliconflow",
        "dashscope",
        "zhipu_glm",
        "moonshot_kimi",
        "openai",
        "gemini",
        "groq",
        "ollama",
        "custom",
      ]
    );
    const nativeJevResolver = new ModelIntentResolver(
      {
        baseURL: "https://api.typesafe.ai",
        model: "~typesafe/jev-latest",
        apiKey: "Bearer ts-native-key",
      },
      async (req) => {
        assert.equal(req.url, "https://api.typesafe.ai/v1/systemone");
        assert.equal(req.headers?.["Authorization"], "Bearer ts-native-key");
        const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
        assert.equal(body["model"], "jev-latest");
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            answers: {
              target: { choice: "d1", confidence: 0.99 },
              op: { choice: "effect_night", confidence: 0.98 },
              temp: { choice: "none", confidence: 1.0 },
            },
          }),
        };
      }
    );
    const nativePlan = await nativeJevResolver.resolve("柔和一点", devices, []);
    assert.deepEqual(nativePlan.intents, [
      { targetId: "dev_ceiling", operation: { kind: "lightEffect", effect: "Night" } },
    ]);

    const deepSeekResolver = new ModelIntentResolver(
      {
        baseURL: "https://api.deepseek.com",
        model: "deepseek-reasoner",
        apiKey: "sk-deepseek-key",
      },
      async (req) => {
        assert.equal(req.url, "https://api.deepseek.com/v1/chat/completions");
        assert.equal(req.headers?.["Authorization"], "Bearer sk-deepseek-key");
        const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
        assert.equal(body["model"], "deepseek-reasoner");
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '<think>分析 {d1}</think>{"actions":[{"device":"d1","op":"effect","value":"Night"}],"reply":"已切换月光"}',
                },
              },
            ],
          }),
        };
      }
    );
    const dsPlan = await deepSeekResolver.resolve("书房月光", devices, []);
    assert.deepEqual(dsPlan.intents, [
      { targetId: "dev_ceiling", operation: { kind: "lightEffect", effect: "Night" } },
    ]);
  });

  it("matches the cross-platform golden JSON corpus shared with MijiaCoreTests", () => {
    const raw = readFileSync(resolve(process.cwd(), "../Tests/Fixtures/intent_golden.json"), "utf8");
    const corpus = JSON.parse(raw) as {
      devices: SmartDevice[];
      intentCases: Array<{
        utterance: string;
        expected: Array<{ targetId: string; kind: string; value: boolean | number | string }> | null;
      }>;
      delayCases: Array<{ utterance: string; seconds: number | null; remainder: string | null }>;
      cancelCases: Array<{ utterance: string; isCancel: boolean }>;
      undoCases: Array<{ utterance: string; isUndo: boolean }>;
    };

    const encodeOp = (intent: { targetId: string; operation: Record<string, unknown> }) => {
      const k = String(intent.operation["kind"]);
      const val =
        intent.operation["isOn"] ??
        intent.operation["percent"] ??
        intent.operation["kelvin"] ??
        intent.operation["effect"] ??
        intent.operation["mode"] ??
        intent.operation["celsius"] ??
        intent.operation["speed"] ??
        intent.operation["enabled"] ??
        intent.operation["delta"] ??
        true;
      return { targetId: intent.targetId, kind: k, value: val };
    };

    for (const item of corpus.intentCases) {
      const plan = LocalIntentParser.parse(item.utterance, corpus.devices, []);
      if (item.expected === null) {
        assert.equal(plan, null, item.utterance);
      } else {
        assert.ok(plan, `Expected plan for: ${item.utterance}`);
        assert.deepEqual(plan.intents.map(encodeOp as never), item.expected, item.utterance);
      }
    }

    for (const item of corpus.delayCases) {
      const got = DelayPhrase.extract(item.utterance);
      if (item.seconds === null || item.remainder === null) {
        assert.equal(got, null, item.utterance);
      } else {
        assert.deepEqual(got, { seconds: item.seconds, remainder: item.remainder }, item.utterance);
      }
    }

    for (const item of corpus.cancelCases) {
      assert.equal(DelayPhrase.isCancel(item.utterance), item.isCancel, item.utterance);
    }

    for (const item of corpus.undoCases) {
      assert.equal(UndoPhrase.isUndo(item.utterance), item.isUndo, item.utterance);
    }
  });
});

describe("AI provider detection and key transport (#19)", () => {
  const studyLight: SmartDevice = {
    id: "dev_ceiling",
    name: "书房吸顶灯",
    roomId: "study",
    roomName: "书房",
    model: "yeelink.light.ceiling20",
    isOnline: true,
    kind: {
      kind: "light",
      entityId: "miot:dev_ceiling:2",
      isOn: false,
      brightnessPercent: 80,
      colorTempKelvin: 4000,
      minKelvin: 2700,
      maxKelvin: 6500,
      currentEffect: "Day",
      availableEffects: ["Day", "Night"],
    },
  };

  it("matches the cross-platform provider corpus shared with MijiaCoreTests", () => {
    const raw = readFileSync(resolve(process.cwd(), "../Tests/Fixtures/provider_golden.json"), "utf8");
    const golden = JSON.parse(raw) as {
      presets: Array<{ url: string; preset: string }>;
      keyTransport: Array<{ url: string; allowsKey: boolean }>;
    };
    assert.ok(golden.presets.length >= 30);
    for (const item of golden.presets) {
      assert.equal(inferAssistantPreset(item.url).id, item.preset, item.url);
    }
    for (const item of golden.keyTransport) {
      assert.equal(endpointAllowsSendingSecrets(item.url), item.allowsKey, item.url);
    }
  });

  it("binds keys to host and port", () => {
    assert.equal(assistantEndpointIdentity("https://Proxy.Example.com:8443/v1"), "proxy.example.com:8443");
    assert.equal(assistantEndpointIdentity("https://openrouter.ai/api/v1"), "openrouter.ai");
    assert.equal(assistantEndpointIdentity("http://[::1]:8080/v1"), "[::1]:8080");
    assert.equal(assistantEndpointIdentity(""), null);
  });

  it("refuses plain http to a public host before sending anything", async () => {
    let calls = 0;
    const resolver = new ModelIntentResolver(
      { baseURL: "http://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-deepseek" },
      async () => {
        calls += 1;
        return { status: 200, headers: {}, body: "{}" };
      }
    );
    await assert.rejects(resolver.resolve("打开书房灯", [studyLight], []), /https/);
    assert.equal(calls, 0);
  });

  it("sends a schemeless URL over https and gives a look-alike OpenRouter host no /api rewrite", async () => {
    const urls: string[] = [];
    const reply = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actions: [], reply: "好" }) } }] });
    const transport = async (req: { url: string }) => {
      urls.push(req.url);
      return { status: 200, headers: {}, body: reply };
    };
    await new ModelIntentResolver({ baseURL: "api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk" }, transport)
      .resolve("打开书房灯", [studyLight], [])
      .catch(() => undefined);
    await new ModelIntentResolver({ baseURL: "https://openrouter.ai.evil.com", model: "gpt-4o-mini", apiKey: "sk" }, transport)
      .resolve("打开书房灯", [studyLight], [])
      .catch(() => undefined);
    assert.deepEqual(urls, [
      "https://api.deepseek.com/v1/chat/completions",
      "https://openrouter.ai.evil.com/v1/chat/completions",
    ]);
  });
});

describe("AI guesses below 80% and risky actions wait for a tap (#21)", () => {
  const light: SmartDevice = {
    id: "dev_light",
    name: "书房台灯",
    roomId: "study",
    roomName: "书房",
    model: "yeelink.light.lamp4",
    isOnline: true,
    kind: {
      kind: "light",
      entityId: "miot:dev_light:2",
      isOn: false,
      brightnessPercent: 50,
      colorTempKelvin: null,
      minKelvin: 2700,
      maxKelvin: 6500,
      currentEffect: null,
      availableEffects: [],
    },
  };
  const heater: SmartDevice = {
    id: "dev_heater",
    name: "次卧取暖器",
    roomId: "guest",
    roomName: "次卧",
    model: "zhimi.heater.za2",
    isOnline: true,
    kind: {
      kind: "climate",
      entityId: "miot:dev_heater:2",
      isOn: false,
      hvacMode: "off",
      availableModes: ["off", "heat"],
      targetTemperature: 20,
      currentTemperature: 16,
      minTemp: 16,
      maxTemp: 28,
      step: 1,
      fanMode: null,
      availableFanModes: [],
    },
  };
  const devices = [light, heater];

  function systemOne(answers: Record<string, unknown>): ModelIntentResolver {
    return new ModelIntentResolver(
      { baseURL: "https://openrouter.ai/api/v1", model: "typesafe/jev-latest", apiKey: "test-key" },
      async () => ({ status: 200, headers: {}, body: JSON.stringify({ answers }) })
    );
  }

  it("reads probabilities, then confidence; a missing number counts as 0", () => {
    assert.equal(ModelActionPolicy.probabilityOf({ probabilities: { a: 0.9 }, confidence: 0.1 }, "a"), 0.9);
    assert.equal(ModelActionPolicy.probabilityOf({ confidence: "85%" }, "a"), 0.85);
    assert.equal(ModelActionPolicy.probabilityOf({ confidence: 50 }, "a"), 0.5);
    assert.equal(ModelActionPolicy.probabilityOf({ choice: "a" }, "a"), 0);
    assert.equal(ModelActionPolicy.probabilityOf(undefined, "a"), 0);
  });

  it("flags heater on but not heater off", () => {
    const needs = (isOn: boolean) =>
      ModelActionPolicy.needsConfirmation({ targetId: "dev_heater", operation: { kind: "power", isOn } }, devices);
    assert.equal(needs(true), true);
    assert.equal(needs(false), false);
    assert.equal(
      ModelActionPolicy.needsConfirmation({ targetId: "dev_light", operation: { kind: "power", isOn: true } }, devices),
      false
    );
  });

  it("turns a 60% System One answer into a chip instead of running it", async () => {
    const plan = await systemOne({
      target: { choice: "d1", confidence: 0.95 },
      op: { choice: "power_on", confidence: 0.6 },
      temp: { choice: "none", confidence: 0.99 },
    }).resolve("有点暗", devices, []);
    assert.deepEqual(plan.intents, []);
    assert.equal(plan.suggestions.length, 1);
    assert.equal(plan.suggestions[0]?.title, "打开书房台灯");
    assert.equal(plan.suggestions[0]?.confidencePercent, 60);
    assert.equal(plan.reply, "没把握直接执行，点下面的建议再执行");
  });

  it("never auto-runs answers that carry no probability, but still offers the chip", async () => {
    const plan = await systemOne({
      target: { choice: "d1" },
      op: { choice: "power_on" },
      temp: { choice: "none" },
    }).resolve("开灯", devices, []);
    assert.deepEqual(plan.intents, []);
    assert.equal(plan.suggestions.length, 1);
    assert.equal(plan.suggestions[0]?.confidencePercent, null);
    assert.deepEqual(plan.suggestions[0]?.intents, [
      { targetId: "dev_light", operation: { kind: "power", isOn: true } },
    ]);
  });

  it("keeps a confident heater-on as a chip", async () => {
    const plan = await systemOne({
      target: { choice: "d2", confidence: 0.99 },
      op: { choice: "power_on", confidence: 0.99 },
      temp: { choice: "none", confidence: 0.99 },
    }).resolve("次卧有点冷", devices, []);
    assert.deepEqual(plan.intents, []);
    assert.deepEqual(plan.suggestions[0]?.intents, [{ targetId: "dev_heater", operation: { kind: "power", isOn: true } }]);
  });

  it("chat models: the light runs, the heater waits, and the reply does not claim it ran", async () => {
    const content = JSON.stringify({
      actions: [
        { device: "d1", op: "power", value: true },
        { device: "d2", op: "power", value: true },
      ],
      reply: "已打开台灯和取暖器",
    });
    const resolver = new ModelIntentResolver(
      { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "test-key" },
      async () => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content } }] }) })
    );
    const plan = await resolver.resolve("我要看书，有点冷", devices, []);
    assert.deepEqual(plan.intents, [{ targetId: "dev_light", operation: { kind: "power", isOn: true } }]);
    assert.equal(plan.suggestions[0]?.id, "confirm:dev_heater");
    assert.equal(plan.suggestions[0]?.confidencePercent, null);
    assert.equal(plan.reply, "已打开书房台灯；下面的建议要点一下才执行");
  });
});

describe("Timers the PC slept through wait for the user (#22)", () => {
  const timer = (id: string, fireTimestampMs: number): ScheduledCommand => ({
    id,
    command: "关闭书房灯",
    delaySeconds: 600,
    fireTimestampMs,
    reply: "10 分钟后：关闭书房灯",
  });

  it("runs on-time timers, holds ones more than a minute late, keeps future ones", () => {
    const now = 10_000_000;
    const result = partitionDueTimers(
      [timer("on-time", now - 1_000), timer("slept", now - 3 * 3600 * 1000), timer("future", now + 5_000)],
      now
    );
    assert.deepEqual(result.run.map((t) => t.id), ["on-time"]);
    assert.deepEqual(result.missed.map((t) => t.id), ["slept"]);
    assert.deepEqual(result.remaining.map((t) => t.id), ["future"]);
  });
});

describe("cloud refresh slows down while the panel is hidden (#26)", () => {
  it("refreshes every 6 s with the panel open (matches macOS) and every 60 s in the tray", () => {
    const last = 1_000_000;
    assert.equal(CLOUD_REFRESH_VISIBLE_MS, 6_000);
    assert.equal(CLOUD_REFRESH_HIDDEN_MS, 60_000);
    assert.equal(cloudRefreshDue(last + 5_999, last, true), false);
    assert.equal(cloudRefreshDue(last + 6_000, last, true), true);
    assert.equal(cloudRefreshDue(last + 30_000, last, false), false);
    assert.equal(cloudRefreshDue(last + 60_000, last, false), true);
  });

  it("opening the panel after a while refreshes at once; the first refresh never waits", () => {
    const last = 1_000_000;
    assert.equal(cloudRefreshDue(last + 40_000, last, false), false);
    assert.equal(cloudRefreshDue(last + 40_000, last, true), true);
    assert.equal(cloudRefreshDue(5, null, false), true);
  });
});

describe("全关 leaves plugs and vacuums alone unless asked (#23)", () => {
  const lamp: SmartDevice = {
    id: "lamp", name: "台灯", roomId: "study", roomName: "书房", model: "yeelink.light.lamp4", isOnline: true,
    kind: {
      kind: "light", entityId: "miot:lamp:2", isOn: true, brightnessPercent: 50, colorTempKelvin: null,
      minKelvin: 2700, maxKelvin: 6500, currentEffect: null, availableEffects: [],
    },
  };
  const router: SmartDevice = {
    id: "router", name: "路由器插座", roomId: "study", roomName: "书房", model: "cuco.plug.v3", isOnline: true,
    kind: { kind: "plug", switchEntityId: "miot:router:2", isOn: true, powerWatts: 9, childLockEntityId: null, isChildLocked: false },
  };

  it("skips plugs by default and follows the user's choice", () => {
    assert.equal(joinsAllOffByDefault(router), false);
    assert.equal(joinsAllOffByDefault(lamp), true);
    assert.deepEqual(allOffTargets([lamp, router], {}).map((d) => d.id), ["lamp"]);
    assert.deepEqual(allOffTargets([lamp, router], { router: true, lamp: false }).map((d) => d.id), ["router"]);
  });
});

describe("Xiaomi cloud regions (#37)", () => {
  it("matches the shared region golden corpus used by both apps", () => {
    const raw = readFileSync(resolve(process.cwd(), "../Tests/Fixtures/region_golden.json"), "utf8");
    const golden = JSON.parse(raw) as { regions: string[] };
    assert.deepEqual(MI_CLOUD_REGIONS.map((region) => region.code), golden.regions);
    assert.deepEqual(golden.regions, ["cn", "de", "i2", "ru", "sg", "us"]);
    assert.equal(new Set(golden.regions).size, golden.regions.length);
  });

  it("normalizes unknown settings back to China Mainland and labels every option", () => {
    assert.equal(normalizeMiCloudRegion("US"), "us");
    assert.equal(normalizeMiCloudRegion(" de "), "de");
    assert.equal(normalizeMiCloudRegion("nope"), "cn");
    assert.equal(normalizeMiCloudRegion(undefined), "cn");
    assert.equal(miCloudRegionLabel("de"), "欧洲 (de)");
    assert.equal(miCloudRegionLabel("i2"), "印度 (i2)");
  });

  it("maps every region to its API host", () => {
    assert.equal(miApiBaseURL("cn"), "https://api.io.mi.com/app");
    assert.equal(miApiBaseURL("de"), "https://de.api.io.mi.com/app");
    assert.equal(miApiBaseURL("i2"), "https://i2.api.io.mi.com/app");
    assert.equal(miApiBaseURL("ru"), "https://ru.api.io.mi.com/app");
    assert.equal(miApiBaseURL("sg"), "https://sg.api.io.mi.com/app");
    assert.equal(miApiBaseURL("us"), "https://us.api.io.mi.com/app");
  });

  it("keeps the selected region in the session returned by QR login", async () => {
    const ticketBody =
      '&&&START&&&{"loginUrl":"https://account.xiaomi.com/longPolling/login?ticket=abc","qr":"https://account.xiaomi.com/longPolling/qr?ticket=abc","lp":"https://lp.example/poll","timeout":"30","code":0}';
    const login = new MiAccountLogin(async (req) => {
      if (req.url.startsWith("https://lp.example")) {
        return {
          status: 200,
          headers: {},
          body: '&&&START&&&{"userId":1234567890,"ssecurity":"c3M=","cUserId":"cu","passToken":"pt","location":"https://sts.example/sts"}',
        };
      }
      if (req.url.startsWith("https://sts.example")) {
        return { status: 200, headers: { "Set-Cookie": "serviceToken=tok-de; path=/" } as Record<string, string>, body: "ok" };
      }
      return { status: 200, headers: {} as Record<string, string>, body: ticketBody };
    }, "de");

    const ticket = await login.start();
    const session = await login.waitForScan(ticket);
    assert.equal(session.region, "de");
    assert.equal(miApiBaseURL(session.region), "https://de.api.io.mi.com/app");
    assert.equal(session.serviceToken, "tok-de");
  });
});

describe("Jev SystemOne request structure parity (#38)", () => {
  const raw = readFileSync(resolve(process.cwd(), "../Tests/Fixtures/ai_request_golden.json"), "utf8");
  const golden = JSON.parse(raw) as {
    utterance: string;
    context: {
      timeSummary: string;
      environmentSummary: string;
      activeDevicesSummary: string;
      habitSummary: string;
    };
    devices: SmartDevice[];
    scenes: Array<{ id: string; name: string; entityId: string }>;
    expected: {
      stateKeys: string[];
      questionsKeys: string[];
      targetAliases: string[];
      catalogDeviceLines: Array<{ alias: string; name: string; room: string; category: string }>;
      catalogSceneLines: Array<{ alias: string; name: string }>;
      decisionHeadCriteriaKeys: Record<string, string[]>;
    };
  };
  const request = buildSystemOneRequestBody({
    model: "~typesafe/jev-latest",
    utterance: golden.utterance,
    devices: golden.devices,
    scenes: golden.scenes,
    context: golden.context,
  });
  const questions = request.body.questions as Record<string, { criteria: Record<string, string> }>;

  it("sends the macOS state block in the same key order", () => {
    assert.deepEqual(Object.keys(request.body.state), golden.expected.stateKeys);
    assert.equal(request.body.state["command"], golden.utterance);
    assert.equal(request.body.state["time"], golden.context.timeSummary);
    assert.equal(request.body.state["environment"], golden.context.environmentSummary);
    assert.equal(request.body.state["active_devices"], golden.context.activeDevicesSummary);
    assert.equal(request.body.state["user_habits"], golden.context.habitSummary);
  });

  it("adds one decision head per controllable device and never truncates at 10", () => {
    assert.deepEqual(Object.keys(request.body.questions), golden.expected.questionsKeys);
    assert.ok(questions["dev_d12"], "the 12th controllable device must keep its head");
    assert.equal(questions["dev_d13"], undefined);
    // Only the 12 controllable devices get heads; the sensor does not.
    assert.equal(Object.keys(request.body.questions).length, 3 + 12);
  });

  it("keeps the catalog aliases, rooms and categories the model sees", () => {
    const catalog = String(request.body.state["catalog"]);
    const marker = "\n场景(id|名称):\n";
    const [devicePart, scenePart] = catalog.split(marker);
    assert.ok(devicePart && scenePart, "catalog must have device and scene sections");
    const deviceLines = devicePart!
      .split("\n")
      .slice(1)
      .map((line) => {
        const [alias, name, room, category] = line.split("|");
        return { alias, name, room, category };
      });
    assert.deepEqual(deviceLines, golden.expected.catalogDeviceLines);
    const sceneLines = scenePart!.split("\n").map((line) => {
      const [alias, name] = line.split("|");
      return { alias, name };
    });
    assert.deepEqual(sceneLines, golden.expected.catalogSceneLines);
  });

  it("offers the same target aliases as macOS, including room and whole-home groups", () => {
    assert.deepEqual(Object.keys(questions["target"]!.criteria), golden.expected.targetAliases);
  });

  it("sends per-device criteria shaped like macOS", () => {
    for (const [head, expectedKeys] of Object.entries(golden.expected.decisionHeadCriteriaKeys)) {
      assert.deepEqual(Object.keys(questions[head]!.criteria), expectedKeys, head);
    }
  });

  it("omits empty ambient summaries instead of sending placeholder keys", () => {
    const bare = buildSystemOneRequestBody({
      model: "~typesafe/jev-latest",
      utterance: golden.utterance,
      devices: golden.devices,
      scenes: golden.scenes,
    });
    assert.deepEqual(Object.keys(bare.body.state), ["catalog", "command"]);
  });
});

describe("assistant ambient context (#38)", () => {
  const light: SmartDevice = {
    id: "lamp",
    name: "客厅吸顶灯",
    roomId: "living",
    roomName: "客厅",
    model: "yeelink.light.ceiling22",
    isOnline: true,
    kind: {
      kind: "light",
      entityId: "miot:lamp:2",
      isOn: true,
      brightnessPercent: 60,
      colorTempKelvin: 4100,
      minKelvin: 2700,
      maxKelvin: 6500,
      currentEffect: "Day",
      availableEffects: ["Day", "Night"],
    },
  };
  const lightKind = light.kind as Extract<SmartDevice["kind"], { kind: "light" }>;
  const offLight: SmartDevice = {
    ...light,
    id: "lamp-off",
    name: "书房台灯",
    kind: { ...lightKind, isOn: false, brightnessPercent: null, currentEffect: null, availableEffects: [] },
  };
  const sensor: SmartDevice = {
    id: "sensor.living",
    name: "客厅温湿度计",
    roomId: "living",
    roomName: "客厅",
    model: "miaomiaoce.sensor_ht.t2",
    isOnline: true,
    kind: { kind: "sensor", temperature: 26.5, humidity: 58, battery: 94 },
  };

  it("formats the time bucket and clock like macOS", () => {
    assert.equal(buildTimeSummary(new Date(2026, 9, 27, 15, 30)), "下午 15:30");
    assert.equal(buildTimeSummary(new Date(2026, 9, 27, 8, 5)), "清晨 08:05");
    assert.equal(buildTimeSummary(new Date(2026, 9, 27, 23, 5)), "深夜 23:05");
  });

  it("summarizes sensors, running devices and learned phrases", () => {
    const context = buildAssistantContext({
      now: new Date(2026, 9, 27, 15, 30),
      readings: [{ id: "sensor.living", label: "客厅温湿度计", roomName: "客厅", temperature: 26.5, humidity: 58, battery: 94 }],
      devices: [light, offLight, sensor],
      habitSummary: buildHabitSummary(true, [{ phrase: "有点热", reply: "已将主卧空调设为 25°C" }]),
    });
    assert.equal(context.timeSummary, "下午 15:30");
    assert.equal(context.environmentSummary, "客厅 26.5°C 58%");
    assert.equal(context.activeDevicesSummary, "客厅吸顶灯(开 亮度60% 当前:Day 可用模式:Day/Night)");
    assert.equal(context.habitSummary, "个人口头禅：「有点热」→已将主卧空调设为 25°C");
  });

  it("says the whole home is off and sends no habits when learning is disabled", () => {
    const context = buildAssistantContext({
      now: new Date(2026, 9, 27, 15, 30),
      readings: [],
      devices: [offLight],
      habitSummary: buildHabitSummary(false, [{ phrase: "有点热", reply: "开空调" }]),
    });
    assert.equal(context.activeDevicesSummary, "全屋设备均关闭");
    assert.equal(context.environmentSummary, "");
    assert.equal(context.habitSummary, "");
    assert.equal(buildHabitSummary(true, []), "");
  });
});

describe("Windows update check (#39)", () => {
  const releaseBody = JSON.stringify({
    tag_name: "v1.0.10",
    html_url: "https://github.com/jryang1997/MenuBarMijia/releases/tag/v1.0.10",
  });

  it("compares dotted versions numerically, not as strings", () => {
    assert.ok(compareVersions("1.0.6", "1.0.10") < 0);
    assert.ok(compareVersions("1.0.10", "1.0.9") > 0);
    assert.equal(compareVersions("v1.0.6", "1.0.6"), 0);
    assert.equal(compareVersions("1.0", "1.0.0"), 0);
    assert.equal(isNewerVersion("v1.0.10", "1.0.6"), true);
    assert.equal(isNewerVersion("1.0.6", "1.0.6"), false);
    assert.equal(isNewerVersion("1.0.5", "1.0.6"), false);
  });

  it("parses GitHub's latest-release payload and rejects malformed bodies", () => {
    assert.deepEqual(parseLatestRelease(releaseBody), {
      version: "1.0.10",
      tag: "v1.0.10",
      htmlURL: "https://github.com/jryang1997/MenuBarMijia/releases/tag/v1.0.10",
    });
    assert.equal(parseLatestRelease("{}"), null);
    assert.equal(parseLatestRelease("not json"), null);
    assert.equal(parseLatestRelease(JSON.stringify({ tag_name: "nightly" })), null);
    assert.deepEqual(
      parseLatestRelease(JSON.stringify({ tag_name: "v1.0.7", html_url: "https://evil.example/release" })),
      {
        version: "1.0.7",
        tag: "v1.0.7",
        htmlURL: "https://github.com/jryang1997/MenuBarMijia/releases/latest",
      },
    );
  });

  it("requests at most once per local calendar day", async () => {
    let calls = 0;
    const requestLatest = async () => {
      calls += 1;
      return { status: 200, body: releaseBody };
    };
    const morning = new Date(2026, 9, 27, 9, 0).getTime();
    const evening = new Date(2026, 9, 27, 20, 0).getTime();
    const nextDay = new Date(2026, 9, 28, 0, 5).getTime();
    assert.equal(updateCheckDayKey(morning), updateCheckDayKey(evening));

    const skipped = await checkForUpdate({
      currentVersion: "1.0.6",
      enabled: true,
      lastCheckedAtMs: morning,
      nowMs: evening,
      requestLatest,
    });
    assert.equal(skipped.requested, false);
    assert.equal(calls, 0);

    const checked = await checkForUpdate({
      currentVersion: "1.0.6",
      enabled: true,
      lastCheckedAtMs: morning,
      nowMs: nextDay,
      requestLatest,
    });
    assert.equal(checked.requested, true);
    assert.equal(checked.updateAvailable, true);
    assert.equal(checked.checkedAtMs, nextDay);
    assert.equal(calls, 1);
  });

  it("never requests when the auto-check switch is off, even for a forced check", async () => {
    let calls = 0;
    const result = await checkForUpdate({
      currentVersion: "1.0.6",
      enabled: false,
      lastCheckedAtMs: null,
      nowMs: Date.now(),
      force: true,
      requestLatest: async () => {
        calls += 1;
        return { status: 200, body: releaseBody };
      },
    });
    assert.equal(result.requested, false);
    assert.equal(result.checkedAtMs, null);
    assert.equal(calls, 0);
  });

  it("does not claim an update when the request or payload fails", async () => {
    const nowMs = new Date(2026, 9, 27, 12, 0).getTime();
    const offline = await checkForUpdate({
      currentVersion: "1.0.6",
      enabled: true,
      lastCheckedAtMs: null,
      nowMs,
      requestLatest: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(offline.requested, true);
    assert.equal(offline.failed, true);
    assert.equal(offline.updateAvailable, false);
    assert.equal(offline.checkedAtMs, nowMs);

    const rateLimited = await checkForUpdate({
      currentVersion: "1.0.6",
      enabled: true,
      lastCheckedAtMs: null,
      nowMs,
      requestLatest: async () => ({ status: 403, body: "rate limited" }),
    });
    assert.equal(rateLimited.failed, true);
    assert.equal(rateLimited.release, null);
  });

  it("round-trips the stored last-check state", () => {
    const state = { lastCheckedAtMs: 1_764_000_000_000, release: parseLatestRelease(releaseBody) };
    assert.deepEqual(parseUpdateState(serializeUpdateState(state)), state);
    assert.deepEqual(parseUpdateState(null), { lastCheckedAtMs: null, release: null });
    assert.deepEqual(parseUpdateState("{bad json"), { lastCheckedAtMs: null, release: null });
  });

  it("selects Windows setup.exe over MSI and requires SHA-256 or sidecar URL", () => {
    const sha = "a".repeat(64);
    const fullPayload = JSON.stringify({
      tag_name: "v1.2.0",
      html_url: "https://github.com/jryang1997/MenuBarMijia/releases/tag/v1.2.0",
      body: "支持应用内一键更新",
      assets: [
        {
          name: "MenuBarMijia-1.2.0-windows-x64.msi",
          browser_download_url:
            "https://github.com/jryang1997/MenuBarMijia/releases/download/v1.2.0/MenuBarMijia-1.2.0-windows-x64.msi",
          size: 4096,
          digest: `sha256:${sha}`,
        },
        {
          name: "MenuBarMijia-1.2.0-windows-x64-setup.exe",
          browser_download_url:
            "https://github.com/jryang1997/MenuBarMijia/releases/download/v1.2.0/MenuBarMijia-1.2.0-windows-x64-setup.exe",
          size: 2048,
          digest: `sha256:${sha.toUpperCase()}`,
        },
        {
          name: "MenuBarMijia-1.2.0-windows-x64-setup.exe.sha256",
          browser_download_url:
            "https://github.com/jryang1997/MenuBarMijia/releases/download/v1.2.0/MenuBarMijia-1.2.0-windows-x64-setup.exe.sha256",
          size: 96,
        },
      ],
    });
    const parsed = parseLatestRelease(fullPayload);
    assert.equal(parsed?.notes, "支持应用内一键更新");
    assert.deepEqual(parsed?.installerAsset, {
      name: "MenuBarMijia-1.2.0-windows-x64-setup.exe",
      downloadURL:
        "https://github.com/jryang1997/MenuBarMijia/releases/download/v1.2.0/MenuBarMijia-1.2.0-windows-x64-setup.exe",
      sizeBytes: 2048,
      sha256: sha,
      checksumURL:
        "https://github.com/jryang1997/MenuBarMijia/releases/download/v1.2.0/MenuBarMijia-1.2.0-windows-x64-setup.exe.sha256",
      signatureURL:
        "https://github.com/jryang1997/MenuBarMijia/releases/download/v1.2.0/MenuBarMijia-1.2.0-windows-x64-setup.exe.ed25519.sig",
    });

    const roundTrip = parseUpdateState(serializeUpdateState({ lastCheckedAtMs: 123, release: parsed }));
    assert.deepEqual(roundTrip.release, parsed);
  });
});

describe("Cross-platform habit memory corpus (#113, ADR-0009)", () => {
  const raw = readFileSync(resolve(process.cwd(), "../Tests/Fixtures/habit_golden.json"), "utf8");
  const corpus = JSON.parse(raw) as {
    devices: SmartDevice[];
    scenes: Array<{ id: string; name: string; entityId: string }>;
    memoryCases: Array<{
      name: string;
      date: string;
      hour: number;
      entriesBefore: Array<{ bucket: string; targetId: string; operationKey: string; count: number; dayType?: string; ageDays?: number }>;
      recordIntents: Array<{ targetId: string; kind: string; value: unknown }>;
      expectReceipt: Array<{
        bucket: string;
        targetId: string;
        operationKey: string;
        dayType: string | null;
        previousCount: number | null;
        previousDayType: string | null;
        previousLastRecordedAtAgeDays?: number | null;
      }> | null;
      entriesAfterRecord: Array<{ bucket: string; targetId: string; operationKey: string; count: number; dayType?: string }>;
      expectUnrecord: boolean;
      entriesAfterUnrecord: Array<{ bucket: string; targetId: string; operationKey: string; count: number; dayType?: string }>;
    }>;
    sequenceCases: Array<{
      name: string;
      date: string;
      hour: number;
      steps: Array<{
        gapMinutes: number | null;
        intents: Array<{ targetId: string; kind: string; value: unknown }>;
        unrecord?: boolean;
      }>;
      expectedSequences: Array<{ afterKey: string; targetId: string; operationKey: string; count: number }>;
      expectedLastAction: { targetId: string; operationKey: string };
    }>;
    topSuggestionCases: Array<{
      name: string;
      date: string;
      hour: number;
      deviceIds: string[];
      entriesBefore: Array<{ bucket: string; targetId: string; operationKey: string; count: number; dayType?: string; ageDays?: number }>;
      favoriteIds: string[];
      environment: Array<{ roomName: string; temperature: number; humidity: number }>;
      limit: number;
      lastAction: { targetId: string; operationKey: string; ageMinutes: number } | null;
      sequencesBefore: Array<{ afterKey: string; targetId: string; operationKey: string; count: number }>;
      expected: Array<Array<{ targetId: string; kind: string; value: unknown }>>;
    }>;
  };

  const toIntent = (item: { targetId: string; kind: string; value: unknown }): DeviceIntent => {
    switch (item.kind) {
      case "power": return { targetId: item.targetId, operation: { kind: "power", isOn: Boolean(item.value) } };
      case "brightness": return { targetId: item.targetId, operation: { kind: "brightness", percent: Number(item.value) } };
      case "colorTemperature": return { targetId: item.targetId, operation: { kind: "colorTemperature", kelvin: Number(item.value) } };
      case "lightEffect": return { targetId: item.targetId, operation: { kind: "lightEffect", effect: String(item.value) } };
      case "hvacMode": return { targetId: item.targetId, operation: { kind: "hvacMode", mode: String(item.value) } };
      case "targetTemperature": return { targetId: item.targetId, operation: { kind: "targetTemperature", celsius: Number(item.value) } };
      case "fanSpeed": return { targetId: item.targetId, operation: { kind: "fanSpeed", speed: String(item.value) } };
      case "oscillation": return { targetId: item.targetId, operation: { kind: "oscillation", enabled: Boolean(item.value) } };
      case "activateScene": return { targetId: item.targetId, operation: { kind: "activateScene" } };
      case "brightnessStep": return { targetId: item.targetId, operation: { kind: "brightnessStep", delta: Number(item.value) } };
      case "temperatureStep": return { targetId: item.targetId, operation: { kind: "temperatureStep", delta: Number(item.value) } };
      default: throw new Error(`unknown operation kind: ${item.kind}`);
    }
  };

  const encodeIntent = (intent: DeviceIntent) => {
    const op = intent.operation;
    const value =
      (op as { isOn?: unknown }).isOn ??
      (op as { percent?: unknown }).percent ??
      (op as { kelvin?: unknown }).kelvin ??
      (op as { effect?: unknown }).effect ??
      (op as { mode?: unknown }).mode ??
      (op as { celsius?: unknown }).celsius ??
      (op as { speed?: unknown }).speed ??
      (op as { enabled?: unknown }).enabled ??
      (op as { delta?: unknown }).delta ??
      true;
    return { targetId: intent.targetId, kind: op.kind, value };
  };

  const caseDate = (date: string, hour: number): Date => {
    const [year, month, day] = date.split("-").map(Number);
    assert.ok(year && month && day);
    return new Date(year, month - 1, day, hour, 30);
  };

  const memoryFrom = (
    entries: Array<{ bucket: string; targetId: string; operationKey: string; count: number; dayType?: string; ageDays?: number }>,
    now: Date,
    sequences: Array<{ afterKey: string; targetId: string; operationKey: string; count: number }> = [],
    lastAction: { targetId: string; operationKey: string; ageMinutes: number } | null = null,
  ) =>
    new UserHabitMemory(
      entries.map((e) => ({
        bucket: e.bucket,
        targetId: e.targetId,
        operationKey: e.operationKey,
        count: e.count,
        dayType: e.dayType as HabitDayType | undefined,
        lastRecordedAtMs: now.getTime() - (e.ageDays ?? 0) * 86_400_000,
      })),
      sequences.map((s) => ({ ...s })),
      lastAction
        ? {
            targetId: lastAction.targetId,
            operationKey: lastAction.operationKey,
            recordedAtMs: now.getTime() - lastAction.ageMinutes * 60_000,
          }
        : null,
    );

  const projectEntries = (memory: UserHabitMemory) =>
    memory.entries.map((e) => ({
      bucket: e.bucket,
      targetId: e.targetId,
      operationKey: e.operationKey,
      count: e.count,
      dayType: e.dayType ?? null,
    }));

  it("matches record/unrecord semantics shared with MijiaCore UserHabitMemory", () => {
    for (const item of corpus.memoryCases) {
      const now = caseDate(item.date, item.hour);
      const memory = memoryFrom(item.entriesBefore, now);
      const intents = item.recordIntents.map(toIntent);
      const receipt = memory.record(intents, corpus.devices, corpus.scenes, now);
      const projectedReceipt = receipt
        ? {
            entries: receipt.entries.map((change) => ({
              bucket: change.bucket,
              targetId: change.targetId,
              operationKey: change.operationKey,
              dayType: change.dayType ?? null,
              previousCount: change.previousCount,
              previousDayType: change.previousDayType ?? null,
              previousLastRecordedAtAgeDays:
                change.previousLastRecordedAtMs === null || change.previousLastRecordedAtMs === undefined
                  ? null
                  : Math.round((now.getTime() - change.previousLastRecordedAtMs) / 86_400_000),
            })),
          }
        : null;
      assert.deepEqual(projectedReceipt?.entries ?? null, item.expectReceipt, item.name);
      assert.deepEqual(projectEntries(memory), item.entriesAfterRecord, item.name);
      if (item.expectUnrecord && receipt) {
        memory.unrecord(receipt);
        assert.deepEqual(projectEntries(memory), item.entriesAfterUnrecord, item.name);
      }
    }
  });

  it("matches sequence learning shared with MijiaCore UserHabitMemory (ADR-0009)", () => {
    for (const item of corpus.sequenceCases) {
      const start = caseDate(item.date, item.hour);
      const memory = new UserHabitMemory();
      let lastAt = start;
      for (const step of item.steps) {
        const at = step.gapMinutes !== null ? new Date(lastAt.getTime() + step.gapMinutes * 60_000) : start;
        lastAt = at;
        const receipt = memory.record(step.intents.map(toIntent), corpus.devices, corpus.scenes, at);
        if (step.unrecord && receipt) memory.unrecord(receipt);
      }
      assert.deepEqual(
        memory.sequences.map((s) => ({ afterKey: s.afterKey, targetId: s.targetId, operationKey: s.operationKey, count: s.count })),
        item.expectedSequences,
        item.name,
      );
      assert.deepEqual(
        memory.lastAction
          ? { targetId: memory.lastAction.targetId, operationKey: memory.lastAction.operationKey }
          : null,
        item.expectedLastAction,
        item.name,
      );
    }
  });

  it("matches the Top-4 proactive engine shared with MijiaCore", () => {
    for (const item of corpus.topSuggestionCases) {
      const now = caseDate(item.date, item.hour);
      const memory = memoryFrom(item.entriesBefore, now, item.sequencesBefore ?? [], item.lastAction ?? null);
      const devices = item.deviceIds.map((id) => {
        const dev = corpus.devices.find((d) => d.id === id);
        assert.ok(dev, `${item.name}: unknown device ${id}`);
        return dev;
      });
      const readings = item.environment.map((r) => ({
        id: r.roomName,
        label: r.roomName,
        roomName: r.roomName,
        temperature: r.temperature,
        humidity: r.humidity,
        battery: null,
      }));
      const suggestions = memory.topSuggestions({
        now,
        devices,
        scenes: corpus.scenes,
        limit: item.limit,
        favoriteIds: item.favoriteIds,
        environmentReadings: readings,
      });
      assert.deepEqual(
        suggestions.map((s) => s.intents.map(encodeIntent)),
        item.expected,
        item.name,
      );
    }
  });
});

describe("Proactive suggestion resolver (#113)", () => {
  const ceiling: SmartDevice = {
    id: "dev_ceiling",
    name: "客厅吸顶灯",
    roomId: "ke_ting",
    roomName: "客厅",
    model: "yeelink.light.ceiling20",
    isOnline: true,
    kind: {
      kind: "light",
      entityId: "light.ceiling",
      isOn: true,
      brightnessPercent: 80,
      colorTempKelvin: 4000,
      minKelvin: 2700,
      maxKelvin: 6500,
      currentEffect: null,
      availableEffects: ["Day", "Night"],
    },
  };
  const ac: SmartDevice = {
    id: "dev_ac",
    name: "客厅空调",
    roomId: "ke_ting",
    roomName: "客厅",
    model: "xiaomi.aircondition.mt0",
    isOnline: true,
    kind: {
      kind: "climate",
      entityId: "climate.ac",
      isOn: true,
      hvacMode: "cool",
      availableModes: ["off", "cool", "heat"],
      targetTemperature: 25,
      currentTemperature: 29.5,
      minTemp: 16,
      maxTemp: 30,
      step: 1,
      fanMode: null,
      availableFanModes: [],
    },
  };
  const devices = [ceiling, ac];
  const context = buildAssistantContext({
    now: new Date(2026, 9, 16, 21, 30),
    readings: [{ id: "r1", label: "温湿度计", roomName: "客厅", temperature: 29.5, humidity: 60, battery: null }],
    devices,
  });

  it("builds the proactive chat prompt and parses ranked suggestions", async () => {
    const captured: Array<{ url: string; body: string }> = [];
    const resolver = new ModelIntentResolver(
      { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "k" },
      async (req) => {
        captured.push({ url: req.url, body: req.body ?? "" });
        const content = '{"suggestions":[{"device":"d1","op":"power","value":false,"confidence":0.9},{"device":"d2","op":"temperature","value":26,"confidence":85}]}';
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ choices: [{ message: { content } }] }),
        };
      },
    );

    const suggestions = await resolver.recommendProactiveSuggestions(devices, [], context);

    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.url, "https://api.deepseek.com/v1/chat/completions");
    const body = JSON.parse(captured[0]?.body ?? "{}") as { messages: Array<{ role: string; content: string }> };
    assert.equal(body.messages[0]?.role, "system");
    assert.match(body.messages[0]?.content ?? "", /主动建议引擎/);
    assert.match(body.messages[0]?.content ?? "", /catalog|设备/);
    // Confidence 0.9 normalizes to 90 and ranks ahead of 85; temperature decodes to targetTemperature.
    assert.deepEqual(
      suggestions.map((s) => [s.confidencePercent, s.intents.map((i) => [i.targetId, i.operation.kind])]),
      [[90, [["dev_ceiling", "power"]]], [85, [["dev_ac", "targetTemperature"]]]],
    );
  });

  it("builds proactive SystemOne heads and parses ranked answers", async () => {
    const captured: Array<{ url: string; body: string }> = [];
    const resolver = new ModelIntentResolver(
      { baseURL: "https://api.typesafe.ai", model: "jev-latest", apiKey: "k" },
      async (req) => {
        captured.push({ url: req.url, body: req.body ?? "" });
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            answers: {
              dev_d2: { choice: "cool_26", probabilities: { cool_26: 0.9 } },
              dev_d1: { choice: "none", probabilities: { power_off: 0.5 } },
            },
          }),
        };
      },
    );

    const suggestions = await resolver.recommendProactiveSuggestions(devices, [], context);

    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.url, "https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(captured[0]?.body ?? "{}") as {
      state: Record<string, unknown>;
      questions: Record<string, { instructions: string }>;
    };
    assert.equal(body.state["environment"], "客厅 29.5°C 60%");
    assert.equal(
      body.state["active_devices"],
      "客厅吸顶灯(开 亮度80% 可用模式:Day/Night)、客厅空调(cool 25°C 可用模式:off/cool/heat 温度范围:16-30°C)",
    );
    assert.match(body.questions["dev_d1"]?.instructions ?? "", /proactive adjustment/);
    // cool_26 expands to mode + temperature; the none head still surfaces its runner-up.
    assert.deepEqual(
      suggestions.map((s) => [s.confidencePercent, s.intents.map((i) => [i.targetId, i.operation.kind])]),
      [[90, [["dev_ac", "hvacMode"], ["dev_ac", "targetTemperature"]]], [50, [["dev_ceiling", "power"]]]],
    );
  });
});

describe("Habit-aware ambient summary (#113)", () => {
  it("includes time-bucket habits in the Jev state summary", () => {
    const light: SmartDevice = {
      id: "dev_ceiling",
      name: "客厅吸顶灯",
      roomId: "ke_ting",
      roomName: "客厅",
      model: "yeelink.light.ceiling20",
      isOnline: true,
      kind: {
        kind: "light",
        entityId: "light.ceiling",
        isOn: true,
        brightnessPercent: 80,
        colorTempKelvin: 4000,
        minKelvin: 2700,
        maxKelvin: 6500,
        currentEffect: null,
        availableEffects: [],
      },
    };
    const memory = new UserHabitMemory([
      { bucket: "夜晚", targetId: "dev_ceiling", operationKey: "power:off", count: 3 },
    ]);
    const summary = buildHabitSummary(
      true,
      [{ phrase: "有点热", reply: "已将主卧空调设为 25°C" }],
      memory,
      [light],
      [],
      new Date(2026, 9, 16, 21, 30),
    );
    assert.match(summary, /^夜晚常做：关闭客厅吸顶灯\(3次\)。个人口头禅：/);
  });
});

describe("Home Assistant snapshot boundary", () => {
  const fixture = JSON.parse(readFileSync(resolve("../Tests/Fixtures/ha_snapshot.json"), "utf8"));
  const regressions = JSON.parse(readFileSync(resolve("../Tests/Fixtures/ha_regressions.json"), "utf8"));
  it("honors explicit outlet metadata when its power entity has an auxiliary-looking name", () => {
    const snapshot = structuredClone(fixture);
    snapshot.devices.push({ id: "renamed-outlet", name: "书房插座", model: "cuco.plug.v3" });
    snapshot.entities.push({ entity_id: "switch.indicator_lamp", device_id: "renamed-outlet" });
    snapshot.states.push({ entity_id: "switch.indicator_lamp", state: "on", attributes: { device_class: "outlet" } });
    const device = HomeAssistantSynthesizer.synthesize(snapshot).devices.find((item) => item.id === "renamed-outlet");
    assert.ok(device?.kind.kind === "plug", "An explicit outlet must not disappear because of its entity name");
    assert.equal(device.kind.switchEntityId, "switch.indicator_lamp");
    assert.equal(device.kind.isOn, true);
  });
  for (const [entityId, deviceClass] of [["sensor.study_airp_index", "aqi"], ["sensor.study_airp_air_quality", "enum"], ["sensor.study_airp_air_quality", "air_quality"]]) {
    it(`prefers the purifier's explicit ${deviceClass} air quality over the PM-derived category`, () => {
      const next = structuredClone(regressions);
      const entity = next.entities.find((entry: { entity_id: string }) => entry.entity_id === "sensor.study_airp_air_quality");
      const state = next.states.find((entry: { entity_id: string }) => entry.entity_id === "sensor.study_airp_air_quality");
      assert.ok(entity && state);
      entity.entity_id = entityId;
      state.entity_id = entityId;
      state.attributes.device_class = deviceClass;
      state.state = "Polluted";
      const purifier = HomeAssistantSynthesizer.synthesize(next).devices.find((device) => device.id === "dev_airp_1");
      assert.ok(purifier?.kind.kind === "fan");
      assert.equal(purifier.kind.pm25Density, 18);
      assert.equal(purifier.kind.airQuality, "Polluted");
    });
  }
  it("keeps camera bearer URLs in memory and strips them from persisted HA cache copies", () => {
    const next = structuredClone(fixture);
    const snapshotPath = "/api/camera_proxy/camera.front?token=expiring-camera-bearer";
    next.states.push({ entity_id: "camera.front", state: "idle", attributes: { entity_picture: snapshotPath } });
    const home = HomeAssistantSynthesizer.synthesize(next);
    const camera = home.devices.find((device) => device.kind.kind === "camera");
    assert.ok(camera?.kind.kind === "camera");
    assert.equal(camera.kind.snapshotPath, snapshotPath);
    const settings = { cachedHAHome: { identity: homeAssistantIdentity("http://localhost:8123", "account"), home } };
    const stored = sanitizeSettingsForStorage(settings);
    const serialized = JSON.stringify(stored);
    assert.equal(serialized.includes("expiring-camera-bearer"), false);
    assert.equal(serialized.includes("camera_proxy"), false);
    assert.equal(camera.kind.snapshotPath, snapshotPath, "Writing settings must not mutate the current camera");
    const cached = parseCachedHAHome(stored.cachedHAHome);
    assert.ok(cached);
    const persistedCamera = cached.home.devices.find((device) => device.kind.kind === "camera");
    assert.ok(persistedCamera?.kind.kind === "camera");
    assert.equal(persistedCamera.kind.snapshotPath, null);
    assert.equal(JSON.stringify(sanitizeSettingsForStorage(JSON.parse(JSON.stringify(settings)))).includes("expiring-camera-bearer"), false);
  });
  it("validates every persisted HA record and nested capability list", () => {
    const identity = homeAssistantIdentity("http://localhost:8123", "token");
    const home = HomeAssistantSynthesizer.synthesize(regressions);
    assert.deepEqual(parseCachedHAHome({ identity, home, endpoint: "obsolete" }), { identity, home });
    for (const key of ["devices", "rooms", "environmentReadings", "scenes"]) {
      for (const invalid of [null, {}, [null], [{}], ["invalid"]]) {
        assert.equal(parseCachedHAHome({ identity, home: { ...home, [key]: invalid } }), null, `${key}=${JSON.stringify(invalid)}`);
      }
    }
    for (const key of ["availableModes", "availableFanModes"]) {
      const device = home.devices.find((entry) => entry.kind.kind === "climate");
      assert.ok(device);
      for (const invalid of [null, {}, [3]]) {
        assert.equal(parseCachedHAHome({ identity, home: { ...home, devices: [{ ...device, kind: { ...device.kind, [key]: invalid } }] } }), null);
      }
    }
    assert.equal(parseCachedHAHome({ identity, home: { devices: [] } }), null);
    assert.equal(homeAssistantIdentity("broken URL", "token"), null);
    assert.equal(homeAssistantIdentity("file:///tmp/home", "token"), null);
  });
  it("synthesizes chuangmi cameras without a camera state and retains control targets", () => {
    const camera = HomeAssistantSynthesizer.synthesize(regressions).devices.find((device) => device.id === "dev_cam_1");
    assert.ok(camera);
    assert.equal(camera.kind.kind, "camera");
    if (camera.kind.kind !== "camera") assert.fail("Expected camera");
    assert.equal(camera.kind.entityId, "switch.living_cam_power|select.living_cam_night_shot");
    assert.equal(camera.kind.streamEntityId, null);
    assert.equal(camera.kind.motionDetectionEntityId, "switch.living_cam_motion_detection");
    assert.equal(camera.kind.nightShot, "Auto");
    assert.deepEqual(haServiceCall({ kind: "setSelectOption", entityId: camera.kind.entityId, option: "On" }), { domain: "select", service: "select_option", entity_id: "select.living_cam_night_shot", data: { option: "On" } });
    assert.deepEqual(haServiceCall({ kind: "setSwitch", entityId: camera.kind.entityId, isOn: false }), { domain: "switch", service: "turn_off", entity_id: "switch.living_cam_power", data: {} });
  });
  it("chooses heat for a heat-only climate and keeps it for inverse power", () => {
    const home = HomeAssistantSynthesizer.synthesize(regressions);
    const device = home.devices.find((item) => item.id === "heat-only");
    assert.ok(device);
    const intent = { targetId: device.id, operation: { kind: "power" as const, isOn: true } };
    const original = IntentValidator.commandsForIntent(intent, device)[0];
    assert.ok(original);
    assert.deepEqual(original, { kind: "setClimatePower", entityId: "climate.study", isOn: true, resumeMode: "cool" });
    const command = homeAssistantCommand(original, home.devices);
    assert.deepEqual(command, { kind: "setClimatePower", entityId: "climate.study", isOn: true, resumeMode: "heat" });
    assert.deepEqual(haServiceCall(command), { domain: "climate", service: "set_hvac_mode", entity_id: "climate.study", data: { hvac_mode: "heat" } });
    assert.deepEqual(haServiceCall({ kind: "setClimatePower", entityId: "climate.study", isOn: false, resumeMode: "heat" }), { domain: "climate", service: "set_hvac_mode", entity_id: "climate.study", data: { hvac_mode: "off" } });
  });
  it("keeps purifier PM2.5 and air quality sensor values separate", () => {
    const purifier = HomeAssistantSynthesizer.synthesize(regressions).devices.find((device) => device.id === "dev_airp_1");
    assert.ok(purifier);
    assert.equal(purifier.kind.kind, "fan");
    if (purifier.kind.kind !== "fan") assert.fail("Expected fan");
    assert.equal(purifier.kind.pm25Density, 18);
    assert.equal(purifier.kind.airQuality, "Excellent");
    assert.equal(purifier.kind.temperature, 24.5);
    assert.equal(purifier.kind.humidity, 52);
    assert.equal(purifier.kind.filterLifePercent, 86);
  });
  it("does not treat unknown or unavailable climate states as active", () => {
    const next = structuredClone(regressions);
    next.states[0].state = "unknown";
    const unknown = HomeAssistantSynthesizer.synthesize(next).devices.find((device) => device.id === "heat-only");
    assert.ok(unknown);
    assert.equal(unknown.isOnline, false);
    assert.equal(unknown.kind.kind, "climate");
    if (unknown.kind.kind !== "climate") assert.fail("Expected climate");
    assert.equal(unknown.kind.isOn, false);
    next.states[0].state = "unavailable";
    const unavailable = HomeAssistantSynthesizer.synthesize(next).devices.find((device) => device.id === "heat-only");
    assert.ok(unavailable);
    assert.equal(unavailable.isOnline, false);
    if (unavailable.kind.kind !== "climate") assert.fail("Expected climate");
    assert.equal(unavailable.kind.isOn, false);
  });
  it("combines registered entities and excludes hidden state fallbacks", () => {
    const home = HomeAssistantSynthesizer.synthesize(fixture);
    assert.deepEqual(home.devices.map((device) => device.id), ["study-light", "thermometer"]);
    assert.equal(home.devices[0]?.kind.kind, "light");
    assert.deepEqual(home.environmentReadings.map((reading) => [reading.temperature, reading.humidity]), [[23.5, 45]]);
    assert.equal(home.rooms.length, 1);
    assert.deepEqual(home.scenes.map((scene) => scene.entityId), ["scene.evening"]);
  });
  it("maps service targets without leaking credentials into packets", () => {
    assert.deepEqual(haServiceCall({kind:"setLightBrightness",entityId:"light.study",percent:40}), {domain:"light",service:"turn_on",entity_id:"light.study",data:{brightness_pct:40}});
    assert.deepEqual(haServiceCall({kind:"activateScene",entityId:"script.evening"}), {domain:"script",service:"turn_on",entity_id:"script.evening",data:{}});
  });
  it("propagates failed native services to the existing rollback caller", async () => {
    const client = new HomeAssistantClient("http://localhost:8123", "test-token", async () => {throw new Error("Home Assistant request failed");});
    await assert.rejects(client.execute({kind:"setLightPower",entityId:"light.study",isOn:false}), /request failed/);
  });
  it("rejects malformed snapshot data at the boundary", () => {
    assert.throws(() => HomeAssistantSynthesizer.synthesize({areas:[],devices:[],entities:[],states:[{entity_id:3}]}), /Invalid Home Assistant/);
  });
  it("isolates cache by canonical origin and credential identity", () => {
    assert.equal(homeAssistantIdentity("HTTP://localhost:8123/","first"),homeAssistantIdentity("http://localhost:8123","first"));
    assert.notEqual(homeAssistantIdentity("http://localhost:8123","first"),homeAssistantIdentity("http://localhost:8123","second"));
    assert.notEqual(homeAssistantIdentity("http://localhost:8123","first"),homeAssistantIdentity("http://localhost:8124","first"));
    assert.ok(!homeAssistantIdentity("http://localhost:8123", "credential-value")?.includes("credential-value"));
  });
  it("does not revive disabled physical devices through state fallback", () => {
    const next = structuredClone(fixture);
    next.devices[0].disabled_by = "user";
    const home = HomeAssistantSynthesizer.synthesize(next);
    assert.deepEqual(home.devices.map((device) => device.id),["thermometer"]);
  });
  it("addresses camera night selection separately from its power entity", () => {
    assert.deepEqual(haServiceCall({kind:"setSelectOption",entityId:"switch.camera|select.camera_night",option:"Auto"}),{domain:"select",service:"select_option",entity_id:"select.camera_night",data:{option:"Auto"}});
    assert.deepEqual(haServiceCall({kind:"setSwitch",entityId:"switch.camera|select.camera_night",isOn:false}),{domain:"switch",service:"turn_off",entity_id:"switch.camera",data:{}});
  });
  it("falls through to entity_id sensor matching when device_class differs and separates plug power from energy", () => {
    const next = structuredClone(regressions);
    const filterState = next.states.find((entry: { entity_id: string }) => entry.entity_id === "sensor.study_airp_filter_life_level");
    assert.ok(filterState);
    filterState.attributes.device_class = "battery";
    next.devices.push({ id: "smart-plug", name: "书房插座", area_id: "study", model: "cuco.plug.v3" });
    next.entities.push(
      { entity_id: "switch.smart_plug", device_id: "smart-plug" },
      { entity_id: "sensor.smart_plug_power_consumption", device_id: "smart-plug" },
      { entity_id: "sensor.smart_plug_electric_power", device_id: "smart-plug" },
    );
    next.states.push(
      { entity_id: "switch.smart_plug", state: "on", attributes: { device_class: "outlet" } },
      { entity_id: "sensor.smart_plug_power_consumption", state: "1.25", attributes: {} },
      { entity_id: "sensor.smart_plug_electric_power", state: "42.5", attributes: {} },
    );
    const home = HomeAssistantSynthesizer.synthesize(next);
    const purifier = home.devices.find((device) => device.id === "dev_airp_1");
    assert.ok(purifier?.kind.kind === "fan");
    assert.equal(purifier.kind.filterLifePercent, 86);
    const plug = home.devices.find((device) => device.id === "smart-plug");
    assert.ok(plug?.kind.kind === "plug");
    assert.equal(plug.kind.powerWatts, 42.5);
    assert.equal(plug.kind.energyKwh, 1.25);
  });
  it("orders environmentReadings by sensor > fan > climate and strips cached camera snapshotPath at parse boundary", () => {
    const next = structuredClone(regressions);
    next.devices.push({ id: "dedicated-th", name: "书房温湿度计", area_id: "study", model: "miaomiaoce.sensor_ht.t2" });
    next.entities.push({ entity_id: "sensor.dedicated_temp", device_id: "dedicated-th" });
    next.states.push({ entity_id: "sensor.dedicated_temp", state: "21.5", attributes: { device_class: "temperature" } });
    next.states[0].attributes.current_temperature = 25;
    const home = HomeAssistantSynthesizer.synthesize(next);
    assert.deepEqual(
      home.environmentReadings.map((reading) => reading.id),
      ["dedicated-th", "dev_airp_1", "heat-only"],
    );
    const identity = homeAssistantIdentity("http://localhost:8123", "token");
    const tampered = structuredClone(home);
    const cam = tampered.devices.find((device) => device.kind.kind === "camera");
    assert.ok(cam?.kind.kind === "camera");
    (cam.kind as { snapshotPath: string | null }).snapshotPath = "C:\\Windows\\System32\\drivers\\etc\\hosts";
    const parsed = parseCachedHAHome({ identity, home: tampered });
    assert.ok(parsed);
    const parsedCam = parsed.home.devices.find((device) => device.kind.kind === "camera");
    assert.ok(parsedCam?.kind.kind === "camera");
    assert.equal(parsedCam.kind.snapshotPath, null);
  });
});

describe("Cross-platform GrokBall emotion & radial stage corpus (#114)", () => {
  const raw = readFileSync(resolve(process.cwd(), "../Tests/Fixtures/grok_ball_golden.json"), "utf8");
  const corpus = JSON.parse(raw) as {
    radialSlots: string[];
    emotionCases: Array<{
      name: string;
      timeBucket: string;
      activeDeviceCount: number;
      speechListening: boolean;
      assistantState: "idle" | "thinking" | "done" | "failed" | "awaitingChoice";
      isRecommending: boolean;
      hasErrorToast: boolean;
      isPointerTracking: boolean;
      isStageExpanded: boolean;
      hasRecentCelebration: boolean;
      expectedEmotionId: string;
    }>;
  };

  it("matches the 4 radial slot order and emotion transitions shared with MijiaCore", () => {
    assert.deepEqual([...GROK_BALL_RADIAL_SLOTS], corpus.radialSlots);
    for (const item of corpus.emotionCases) {
      const actual = resolveGrokBallEmotion({
        timeBucket: item.timeBucket,
        activeDeviceCount: item.activeDeviceCount,
        speechListening: item.speechListening,
        assistantState: item.assistantState,
        isRecommending: item.isRecommending,
        hasErrorToast: item.hasErrorToast,
        isPointerTracking: item.isPointerTracking,
        isStageExpanded: item.isStageExpanded,
        hasRecentCelebration: item.hasRecentCelebration,
      });
      assert.equal(actual, item.expectedEmotionId, item.name);
    }
  });
});
