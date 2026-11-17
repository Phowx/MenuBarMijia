import { readFileSync } from "node:fs";
import { HomeAssistantSynthesizer, homeAssistantIdentity } from "../src/core/homeAssistant.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Window } from "happy-dom";

import { installWindow } from "./dom.js";
import { MenuMijiaWindowsApp } from "../src/ui/app.js";
import type { DeviceIntent } from "../src/core/models.js";
import { cloudFixture } from "./cloudFixture.js";
import { MiCloudClient, MiotSynthesizer } from "../src/core/miCloudClient.js";
import { MiCloudCrypto } from "../src/core/miCloudCrypto.js";

let dom: Window;

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  assert.ok(found, `Missing control ${selector}`);
  return found;
}

async function click(selector: string): Promise<void> {
  element(selector).click();
  await setImmediate();
}

function tile(id: string): string {
  return element(`[data-body-device="${id}"]`).textContent ?? "";
}

function textOf(selector: string): string {
  return element(selector).textContent ?? "";
}

function startDemo(): void {
  localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({
    connectionMode: "demo",
    hasCompletedOnboarding: true,
  }));
  new MenuMijiaWindowsApp(element("#app"));
}

async function setRange(selector: string, value: string): Promise<void> {
  const slider = document.querySelector<HTMLInputElement>(selector);
  assert.ok(slider);
  slider.value = value;
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  await setImmediate();
}

function openSearch(): HTMLInputElement {
  if (!document.querySelector("#device-search")) element("#btn-device-search").click();
  return element("#device-search") as HTMLInputElement;
}

function searchFor(query: string): HTMLInputElement {
  const search = openSearch();
  search.focus();
  search.value = query;
  search.dispatchEvent(new Event("input", { bubbles: true }));
  return element("#device-search") as HTMLInputElement;
}

// Exercise ordered multi-attribute plans that the current panel cannot compose.
function runStructuredActions(app: MenuMijiaWindowsApp, intents: readonly DeviceIntent[]): Promise<boolean> {
  const executor = app as unknown as {
    executeIntents(intents: readonly DeviceIntent[], summary: string, source: string): Promise<boolean>;
  };
  return executor.executeIntents(intents, "测试操作", "测试");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail("Timed out waiting for UI state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

beforeEach(() => {
  dom = new Window({ url: "http://localhost/" });
  installWindow(dom);
  // The suite asserts Simplified Chinese chrome; pin the OS language so `system` resolves to it.
  Object.defineProperty(dom.navigator, "languages", { value: ["zh-CN", "zh"], configurable: true });
  Object.defineProperty(dom.navigator, "language", { value: "zh-CN", configurable: true });
  document.body.innerHTML = '<div id="app"></div>';

});

afterEach(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

describe("Service endpoint submission", () => {
  it("submits only the Home Assistant URL and ignores the legacy AI endpoint", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke = async (command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      return undefined;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({
      connectionMode: "demo",
      hasCompletedOnboarding: true,
      assistantBaseURL: "HTTPS://API.DeepSeek.com:8443/v1",
      haBaseURL: "http://[::1]:8123/api",
    }));

    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();

    assert.deepEqual(calls.filter((call) => call.command === "set_service_endpoints").map((call) => call.args), [
      { haUrl: "http://[::1]:8123/api" },
    ]);
    assert.equal(calls.some((call) => call.command === "set_allowed_origins"), false);
  });

  it("does not re-prompt a declined endpoint on unrelated background saves, but retries when settings are explicitly saved", async () => {
    let endpointAttempts = 0;
    const invoke = async (command: string) => {
      if (command === "set_service_endpoints") {
        endpointAttempts += 1;
        throw new Error("未授权访问来源：https://api.deepseek.com:8443");
      }
      return undefined;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({
      connectionMode: "demo",
      hasCompletedOnboarding: true,
      assistantBaseURL: "https://api.deepseek.com:8443/v1",
      haBaseURL: "",
    }));

    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();
    assert.equal(endpointAttempts, 1);

    // Unrelated settings saves (e.g. toggling interface language or background cloud refresh) must not re-prompt.
    await click("#btn-settings");
    await click('[data-interface-language="zh-Hans"]');
    await setImmediate();
    assert.equal(endpointAttempts, 1);

    // Clicking "保存设置" explicitly retries endpoint authorization.
    await click("#btn-save-settings");
    await setImmediate();
    assert.equal(endpointAttempts, 2);
  });
});

describe("Windows device control and undo", () => {
  it("finds devices by name, room, full pinyin and initials without executing input", async () => {
    startDemo();
    assert.equal(document.querySelector(".cc-search-section"), null);
    assert.equal(element("#btn-device-search").getAttribute("aria-expanded"), "false");
    window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "f", ctrlKey: true }) as unknown as Event);
    assert.equal(document.activeElement, element("#device-search"));
    assert.match(tile("light.living_ceiling"), /已开启/);
    for (const query of ["客厅", "keting", "kt", "xidingdeng", "xdd"]) {
      const search = searchFor(query);
      assert.equal(document.activeElement, search);
      assert.equal(search.value, query);
      assert.match(tile("light.living_ceiling"), /客厅吸顶灯/);
      assert.equal(document.querySelector('[data-tile-id="fan.bedroom_standing"]'), null);
    }
    const search = searchFor("关闭所有灯");
    search.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    assert.match(textOf(".cc-scroll-area"), /找不到匹配的设备/);
    search.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    assert.equal(document.querySelector("#device-search"), null);
    assert.equal(document.activeElement, element("#btn-device-search"));
    assert.equal(openSearch().value, "");
    assert.match(tile("light.living_ceiling"), /已开启/);
  });

  it("hides a device from cards, search and quick actions and restores it from Settings", async () => {
    startDemo();
    await click('[data-room="客厅"]');
    const card = '[data-tile-id="light.living_ceiling"]';
    element(card).dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true }) as unknown as Event);
    await click('[data-hide-device="light.living_ceiling"]');
    assert.equal(document.querySelector(card), null);
    const saved = JSON.parse(localStorage.getItem("menumijia.windows.settings.v2") ?? "{}");
    assert.deepEqual(saved.layout.hiddenDeviceIds.demo, ["light.living_ceiling"]);
    searchFor("xdd");
    assert.match(textOf(".cc-scroll-area"), /找不到匹配的设备/);
    await click("#btn-device-search");
    await click('[data-quick-action="lights_off"]');
    assert.equal(document.querySelector("#btn-undo"), null);

    await click("#btn-settings");
    assert.match(textOf(".cc-sheet"), /已隐藏的设备 \(1\)/);
    await click('[data-unhide-device="light.living_ceiling"]');
    await click("#btn-close-settings");
    assert.match(tile("light.living_ceiling"), /已开启/);
  });

  it("runs a structured quick action and undoes it using the panel button", async () => {
    startDemo();
    await click('[data-room="客厅"]');
    await click('[data-quick-action="lights_off"]');
    assert.match(tile("light.living_ceiling"), /已关闭/);
    await click("#btn-undo");
    assert.match(tile("light.living_ceiling"), /已开启/);
  });

  it("restores an originally off light without turning it on through brightness", async () => {
    startDemo();
    await click('[data-toggle-device="light.living_ceiling"]');
    assert.match(tile("light.living_ceiling"), /已关闭/);
    await click('[data-toggle-device="light.living_ceiling"]');
    assert.match(tile("light.living_ceiling"), /已开启/);
    await click("#btn-undo");
    assert.match(tile("light.living_ceiling"), /已关闭/);
    assert.match(document.body.textContent ?? "", /已撤销/);
  });

  it("restores the changed light color temperature without changing brightness", async () => {
    startDemo();
    await click('[data-expand-device="light.living_ceiling"]');
    await setRange('[data-colortemp="light.living_ceiling"]', "5500");
    assert.match(tile("light.living_ceiling"), /5500K/);
    await click("#btn-undo");
    assert.match(tile("light.living_ceiling"), /78% · 4100K/);
  });

  it("restores ordinary color temperature after a light-effect action", async () => {
    startDemo();
    await click('[data-expand-device="light.living_ceiling"]');
    await setRange('[data-colortemp="light.living_ceiling"]', "5500");
    await click('[data-lighteffect="light.living_ceiling"][data-effect="Night"]');
    assert.match(tile("light.living_ceiling"), /月光/);
    await click("#btn-undo");
    assert.match(tile("light.living_ceiling"), /5500K/);
    assert.doesNotMatch(tile("light.living_ceiling"), /月光/);
  });

  it("switches moonlight from the light drawer and restores its original mode on undo", async () => {
    startDemo();
    await click('[data-expand-device="light.living_ceiling"]');
    const daylight = '[data-lighteffect="light.living_ceiling"][data-effect="Day"]';
    const moonlight = '[data-lighteffect="light.living_ceiling"][data-effect="Night"]';
    assert.equal(element(daylight).getAttribute("aria-pressed"), "true");
    await click(moonlight);
    assert.match(tile("light.living_ceiling"), /月光/);
    assert.match(tile("light.living_ceiling"), /78%/);
    assert.match(tile("light.living_ceiling"), /4100K/);
    assert.equal(element(moonlight).getAttribute("aria-pressed"), "true");
    await click("#btn-undo");
    assert.match(tile("light.living_ceiling"), /日光/);
    assert.equal(element(daylight).getAttribute("aria-pressed"), "true");
  });

  it("restores a fan preset and its initially off power state", async () => {
    startDemo();
    await click('[data-expand-device="fan.bedroom_standing"]');
    await click('[data-fanpreset="fan.bedroom_standing:Level 4"]');
    assert.match(tile("fan.bedroom_standing"), /Level 4/);
    await click("#btn-undo");
    assert.match(tile("fan.bedroom_standing"), /已关闭/);
    assert.equal(element('[data-fanpreset="fan.bedroom_standing:Level 2"]').classList.contains("is-active"), true);
  });

  it("restores fan oscillation and its initially off power state", async () => {
    startDemo();
    await click('[data-expand-device="fan.bedroom_standing"]');
    await click('[data-fanosc="fan.bedroom_standing"]');
    assert.match(tile("fan.bedroom_standing"), /摇头/);
    await click("#btn-undo");
    assert.match(tile("fan.bedroom_standing"), /已关闭/);
    assert.match(element('[data-fanosc="fan.bedroom_standing"]').textContent ?? "", /摇头 关/);
  });

  it("undoes only acknowledged attributes when another command on the same device fails", async () => {
    const cloud = cloudFixture([]);
    const app = new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();
    assert.match(tile("fixture-light"), /50% · 4100K/);
    await runStructuredActions(app, [
      { targetId: "fixture-light", operation: { kind: "brightness", percent: 80 } },
      { targetId: "fixture-light", operation: { kind: "colorTemperature", kelvin: 5500 } },
    ]);
    assert.match(document.body.textContent ?? "", /1 项失败/);
    assert.match(tile("fixture-light"), /50% · 5500K/);
    cloud.values.set(2, 90);
    await click("#btn-refresh");
    assert.match(tile("fixture-light"), /90% · 5500K/);
    cloud.allowBrightness();
    await click("#btn-undo");
    assert.match(tile("fixture-light"), /90% · 4100K/);
    assert.equal(cloud.values.get(2), 90);
    assert.equal(cloud.values.get(3), 4100);
  });

  it("reverses multiple acknowledged changes to the same attribute in execution order", async () => {
    const cloud = cloudFixture([]);
    cloud.allowBrightness();
    const app = new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();
    await runStructuredActions(app, [
      { targetId: "fixture-light", operation: { kind: "brightness", percent: 80 } },
      { targetId: "fixture-light", operation: { kind: "brightness", percent: 60 } },
    ]);
    assert.match(tile("fixture-light"), /60%/);
    await click("#btn-undo");
    assert.match(tile("fixture-light"), /50%/);
    assert.equal(cloud.values.get(2), 50);
  });

  it("preserves final power correction when a failed undo is retried", async () => {
    const cloud = cloudFixture([]);
    cloud.values.set(1, false);
    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();
    assert.match(tile("fixture-light"), /已关闭/);
    await click('[data-expand-device="fixture-light"]');
    await setRange('[data-colortemp="fixture-light"]', "5500");
    cloud.reject(3, 4100);
    await click("#btn-undo");
    assert.match(document.body.textContent ?? "", /撤销未完成/);
    assert.match(tile("fixture-light"), /已关闭/);
    cloud.allow(3);
    await click("#btn-undo");
    assert.match(tile("fixture-light"), /已关闭/);
    assert.equal(cloud.values.get(1), false);
    assert.equal(cloud.values.get(3), 4100);
    assert.match(document.body.textContent ?? "", /已撤销/);
  });
});

describe("Silent Xiaomi cloud refresh (#81)", { concurrency: false }, () => {
  async function readyCloudApp(configure?: (cloud: ReturnType<typeof cloudFixture>) => void): Promise<{
    cloud: ReturnType<typeof cloudFixture>;
    triggerRefresh(): void;
    runTimerTick(): void;
  }> {
    const cloud = cloudFixture([]);
    configure?.(cloud);
    let timerTick: (() => void) | null = null;
    const timerWindow = window as unknown as {
      setInterval: (handler: () => void, timeout?: number) => number;
    };
    const originalSetInterval = timerWindow.setInterval;
    timerWindow.setInterval = (handler) => {
      timerTick = handler;
      return 1;
    };
    new MenuMijiaWindowsApp(element("#app"));
    timerWindow.setInterval = originalSetInterval;
    assert.ok(timerTick, "app did not install its timer loop");
    for (let i = 0; i < 3; i++) await setImmediate();
    await waitFor(
      () => !document.querySelector("#btn-refresh")?.classList.contains("is-spinning"),
    );
    assert.match(tile("fixture-light"), /50%/);
    const runTimerTick = () => (timerTick as () => void)();
    let refreshOffset = 0;
    return {
      cloud,
      runTimerTick,
      triggerRefresh: () => {
        refreshOffset += 7_000;
        const realNow = Date.now;
        Date.now = () => realNow() + refreshOffset;
        try {
          runTimerTick();
        } finally {
          Date.now = realNow;
        }
      },
    };
  }

  it("keeps successful sync in the footer and clears a sync error after recovery", async () => {
    const { cloud } = await readyCloudApp();
    assert.match(textOf(".cc-footer-label"), /1 台设备/);
    assert.equal(document.querySelector(".cc-search-section"), null);
    cloud.setDeviceListFailure(true);
    await click("#btn-refresh");
    await waitFor(() => !!document.querySelector(".cc-feedback-card.is-error"));
    assert.match(textOf(".cc-feedback-text"), /米家云同步失败/);
    cloud.setDeviceListFailure(false);
    await click("#btn-refresh");
    await waitFor(() => !document.querySelector(".cc-search-section"));
  });

  it("reapplies the offline visibility setting when polling changes connectivity", async () => {
    const { cloud, triggerRefresh } = await readyCloudApp();
    await click("#btn-settings");
    await click("#settings-hide-offline");
    await click("#btn-close-settings");
    cloud.deviceRecords[0]!.isOnline = false;
    triggerRefresh();
    await waitFor(() => !document.querySelector('[data-tile-id="fixture-light"]'));
    assert.match(textOf(".cc-scroll-area"), /当前没有可显示的设备/);
    cloud.deviceRecords[0]!.isOnline = true;
    triggerRefresh();
    await waitFor(() => !!document.querySelector('[data-tile-id="fixture-light"]'));
  });

  it("keeps device and room positions when cloud polling permutes the same records", async () => {
    const { cloud, triggerRefresh } = await readyCloudApp((fixture) => {
      const light = fixture.deviceRecords[0];
      assert.ok(light);
      fixture.deviceRecords.push({ ...light, did: "second-light", name: "第二盏灯" });
      fixture.deviceRecords.push(
        fixture.sensorRecord("sensor-bedroom", "主卧温湿度计"),
        fixture.sensorRecord("sensor-balcony", "阳台温湿度计"),
      );
      fixture.roomRecords.push(
        { id: "living", name: "客厅", dids: ["fixture-light"] },
        { id: "study", name: "书房", dids: ["second-light"] },
      );
    });
    const ids = () => Array.from(document.querySelectorAll<HTMLElement>("[data-tile-id]"), (node) => node.dataset.tileId);
    const rooms = () => Array.from(document.querySelectorAll<HTMLElement>("[data-room]"), (node) => node.dataset.room);
    const initialIds = ids();
    const initialRooms = rooms();
    const envLabels = () => Array.from(document.querySelectorAll(".cc-env-label"), (node) => node.textContent);
    const initialEnvLabels = envLabels();
    assert.deepEqual(initialEnvLabels, ["主卧", "阳台"]);
    const popover = element(".cc-popover");
    for (let i = 0; i < 4; i++) {
      cloud.deviceRecords.reverse();
      cloud.roomRecords.reverse();
      cloud.values.set(2, 51 + i);
      cloud.sensorValues.set(1, 24 + i);
      const held = cloud.holdNextRead();
      triggerRefresh();
      await withTimeout(held.started, "Polling did not request properties");
      held.release();
      await withTimeout(held.finished, "Polling did not finish");
      await setImmediate();
      assert.deepEqual(ids(), initialIds, "cloud response order moved device tiles");
      assert.deepEqual(rooms(), initialRooms, "cloud response order moved room tabs");
      assert.deepEqual(envLabels(), initialEnvLabels, "cloud response order moved environment chips");
      assert.match(tile("fixture-light"), new RegExp(`${51 + i}%`));
      assert.match(textOf(".cc-env-strip"), new RegExp(`${24 + i}\\.0`));
      assert.ok(element(".cc-popover") === popover, "order-only refresh rebuilt the panel");
    }
  });

  it("appends new devices, removes missing devices and retains a partial custom order", async () => {
    const { cloud, triggerRefresh } = await readyCloudApp((fixture) => {
      const light = fixture.deviceRecords[0];
      assert.ok(light);
      fixture.deviceRecords.push(
        { ...light, did: "second-light" }, { ...light, did: "third-light" },
      );
      const stored = localStorage.getItem("menumijia.windows.settings.v2");
      assert.ok(stored);
      localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({
        ...JSON.parse(stored), layout: { order: ["third-light"] },
      }));
    });
    const light = cloud.deviceRecords[0];
    assert.ok(light);
    cloud.deviceRecords.splice(0, cloud.deviceRecords.length,
      { ...light, did: "new-light" }, { ...light, did: "third-light" }, light,
    );
    const held = cloud.holdNextRead();
    triggerRefresh();
    await withTimeout(held.started, "Polling did not request properties");
    held.release();
    await withTimeout(held.finished, "Polling did not finish");
    await setImmediate();
    assert.deepEqual(
      Array.from(document.querySelectorAll<HTMLElement>("[data-tile-id]"), (node) => node.dataset.tileId),
      ["third-light", "fixture-light", "new-light"],
    );
    const stored = localStorage.getItem("menumijia.windows.settings.v2");
    assert.ok(stored);
    const cached: unknown = JSON.parse(stored);
    assert.ok(cached && typeof cached === "object" && "cachedXiaomiDevices" in cached && Array.isArray(cached.cachedXiaomiDevices));
    assert.deepEqual(cached.cachedXiaomiDevices.map((device) => device.id), ["fixture-light", "third-light", "new-light"]);
  });

  it("retains the cached device positions on the first refresh after restart", async () => {
    await readyCloudApp((fixture) => {
      const light = fixture.deviceRecords[0];
      assert.ok(light);
      fixture.deviceRecords.push({ ...light, did: "second-light" });
      const records = MiCloudClient.parseDeviceList({ list: [...fixture.deviceRecords].reverse() });
      const cached = MiotSynthesizer.synthesize(records, [], {}, new Map());
      const stored = localStorage.getItem("menumijia.windows.settings.v2");
      assert.ok(stored);
      localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({
        ...JSON.parse(stored), cachedXiaomiDevices: cached.devices,
      }));
    });
    assert.deepEqual(
      Array.from(document.querySelectorAll<HTMLElement>("[data-tile-id]"), (node) => node.dataset.tileId),
      ["second-light", "fixture-light"],
    );
  });

  it("keeps the current DOM when polling returns the same snapshot", async () => {
    const { cloud, triggerRefresh } = await readyCloudApp();
    const input = openSearch();
    const popover = element(".cc-popover");
    input.value = "未发送的草稿";
    input.focus();
    const heldRead = cloud.holdNextRead();

    triggerRefresh();
    await withTimeout(heldRead.started, "Cloud refresh did not reach the no-op gate");
    heldRead.release();
    await withTimeout(heldRead.finished, "Cloud response did not finish");
    await setImmediate();

    assert.equal(element(".cc-popover"), popover);
    assert.equal(element("#device-search"), input);
    assert.equal(document.activeElement, input);
    assert.equal(input.value, "未发送的草稿");
  });

  it("patches a real state change without disturbing the search draft", async () => {
    const { cloud, triggerRefresh } = await readyCloudApp();
    const input = openSearch();
    const inputNode = input;
    input.value = "未发送的草稿";
    input.focus();
    cloud.values.set(2, 90);

    triggerRefresh();
    await waitFor(() => tile("fixture-light").includes("90%"));
    assert.match(tile("fixture-light"), /90%/);
    assert.ok(element("#device-search") === inputNode, "search input was replaced");
    assert.ok(document.activeElement === inputNode, "search focus moved");
    assert.equal(input.value, "未发送的草稿");
  });

  it("discards a stale cloud snapshot after a newer command has completed", async () => {
    const { cloud, triggerRefresh } = await readyCloudApp();
    const heldRead = cloud.holdNextRead();
    triggerRefresh();
    await withTimeout(heldRead.started, "Cloud refresh did not reach the stale response gate");
    await click('[data-toggle-device="fixture-light"]');
    await waitFor(() => cloud.writes.filter((write) => write.piid === 1).length === 1);
    assert.match(tile("fixture-light"), /已关闭/);

    heldRead.release();
    await withTimeout(heldRead.finished, "Stale cloud response did not finish");
    await setImmediate();
    assert.match(tile("fixture-light"), /已关闭/);

    await click('[data-toggle-device="fixture-light"]');
    await waitFor(() => cloud.writes.filter((write) => write.piid === 1).length === 2);
    assert.match(tile("fixture-light"), /已开启/);
    assert.deepEqual(
      cloud.writes.filter((write) => write.piid === 1).map((write) => write.value),
      [false, true],
    );
  });

  it("patches dynamic values without replacing the focused device control", async () => {
    const { cloud, triggerRefresh } = await readyCloudApp();
    const toggle = element('[data-toggle-device="fixture-light"]');
    const tileNode = element('[data-tile-id="fixture-light"]');
    toggle.focus();
    const heldRead = cloud.holdNextRead();
    cloud.values.set(2, 90);
    triggerRefresh();
    await withTimeout(heldRead.started, "Cloud refresh did not reach the focused-control gate");
    heldRead.release();
    await withTimeout(heldRead.finished, "Cloud response did not finish");
    await waitFor(() => tile("fixture-light").includes("90%"));

    assert.match(tile("fixture-light"), /90%/);
    assert.ok(element('[data-toggle-device="fixture-light"]') === toggle, "device control was replaced");
    assert.ok(element('[data-tile-id="fixture-light"]') === tileNode, "device tile was replaced");
    assert.ok(document.activeElement === toggle, "keyboard focus moved");
  });

  it("keeps keyboard focus on an id-less device control across a structural refresh", async () => {
    const { cloud, triggerRefresh } = await readyCloudApp();
    element('[data-toggle-device="fixture-light"]').focus();
    cloud.values.set(1, false);

    triggerRefresh();
    await waitFor(() => tile("fixture-light").includes("已关闭"));

    assert.match(tile("fixture-light"), /已关闭/);
    assert.ok(
      document.activeElement === element('[data-toggle-device="fixture-light"]'),
      "device control lost keyboard focus",
    );
  });

  it("does not let an open detail drawer block structural updates forever", async () => {
    const { cloud, triggerRefresh } = await readyCloudApp();
    await click('[data-expand-device="fixture-light"]');
    assert.ok(document.querySelector(".cc-tile-drawer"), "detail drawer did not open");
    cloud.values.set(1, false);

    triggerRefresh();
    await waitFor(() => tile("fixture-light").includes("已关闭"));

    assert.match(tile("fixture-light"), /已关闭/);
    assert.ok(document.querySelector(".cc-tile-drawer"), "detail drawer closed after refresh");
  });

  it("updates and restores focus when a detail slider is focused", async () => {
    const { cloud, triggerRefresh } = await readyCloudApp();
    await click('[data-expand-device="fixture-light"]');
    const slider = element('[data-brightness="fixture-light"]');
    slider.focus();
    cloud.values.set(1, false);
    cloud.values.set(2, 90);

    triggerRefresh();
    await waitFor(() => tile("fixture-light").includes("已关闭"));

    assert.match(tile("fixture-light"), /已关闭/);
    assert.ok(document.querySelector(".cc-tile-drawer"), "detail drawer closed after refresh");
    const restored = element('[data-brightness="fixture-light"]') as HTMLInputElement;
    assert.ok(document.activeElement === restored, "focused detail slider was not restored");
    assert.equal(restored.value, "90");
  });

  it("updates a focused range value when polling patches in place", async () => {
    const { cloud, triggerRefresh } = await readyCloudApp();
    await click('[data-expand-device="fixture-light"]');
    const slider = element('[data-brightness="fixture-light"]') as HTMLInputElement;
    slider.focus();
    slider.value = "60";
    cloud.values.set(2, 90);

    triggerRefresh();
    await waitFor(() => tile("fixture-light").includes("90%"));

    const patched = element('[data-brightness="fixture-light"]') as HTMLInputElement;
    assert.ok(patched === slider, "focused slider was replaced by the value-only patch");
    assert.equal(patched.value, "90");
    assert.ok(document.activeElement === patched, "focused slider lost focus");
  });

  it("waits to patch the panel while a pointer interaction is in progress", async () => {
    const { cloud, triggerRefresh, runTimerTick } = await readyCloudApp();
    const toggle = element('[data-toggle-device="fixture-light"]');
    toggle.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    cloud.values.set(2, 90);
    const reads = cloud.completedReads();

    triggerRefresh();
    await waitFor(() => cloud.completedReads() > reads);
    assert.match(tile("fixture-light"), /50%/);

    window.dispatchEvent(new Event("pointerup", { bubbles: true }));
    runTimerTick();
    await waitFor(() => tile("fixture-light").includes("90%"));
  });
});

describe("Credentials move out of localStorage (#28)", () => {
  it("migrates old plaintext credentials into the credential manager and strips the copy", async () => {
    const store = new Map<string, string>();
    const invoke = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T | null> => {
      const name = String(args["name"] ?? "");
      if (cmd === "secure_store_set") {
        store.set(name, String(args["value"] ?? ""));
        return null;
      }
      if (cmd === "secure_store_get") return (store.get(name) ?? null) as T | null;
      if (cmd === "secure_store_delete") {
        store.delete(name);
        return null;
      }
      return null;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({
      connectionMode: "demo",
      hasCompletedOnboarding: true,
      assistantBaseURL: "https://openrouter.ai/api/v1",
      openRouterApiKey: "sk-live",
      haToken: "ha-token",
      miSession: {
        userId: "1000000000",
        cUserId: "abc",
        ssecurity: "ssecurity-value",
        serviceToken: "service-token-value",
        passToken: "account-level-pass-token",
        region: "cn",
      },
    }));

    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();
    await setImmediate();

    const saved = JSON.parse(localStorage.getItem("menumijia.windows.settings.v2") ?? "{}") as Record<string, unknown>;
    assert.equal("miSession" in saved, false);
    assert.equal("haToken" in saved, false);
    assert.equal("openRouterApiKey" in saved, false);
    assert.deepEqual([...store.keys()].sort(), ["assistant_api_key", "ha_token", "mi_session"]);
    assert.equal(store.get("mi_session")?.includes("passToken"), false);
    assert.equal(store.get("mi_session")?.includes("account-level-pass-token"), false);

    // A later launch reads only the credential manager, so the upgrade needs no new QR login.
    document.body.innerHTML = '<div id="app"></div>';
    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();
    await setImmediate();
    await click("#btn-settings");
    assert.match(document.body.textContent ?? "", /已登录 10\*\*\*\*00/);
  });
});

describe("全关 (#23)", () => {
  it("needs a hold in the classic skin and leaves the plug on", async () => {
    startDemo();
    const button = element("#btn-all-off");
    assert.match(button.textContent ?? "", /全关 \(3\)/);
    button.click();
    await setImmediate();
    assert.match(tile("light.living_ceiling"), /已开启/);

    button.dispatchEvent(new Event("pointerdown"));
    await new Promise((resolve) => setTimeout(resolve, 700));
    await setImmediate();
    assert.doesNotMatch(tile("light.living_ceiling"), /已开启/);
    assert.match(tile("plug.entry_socket"), /供电中/);
  });
});

describe("Xiaomi cloud region switch (#37)", () => {
  it("names the current region in the empty state and saves a newly selected region", async () => {
    localStorage.removeItem("menumijia.windows.update.v1");
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({
      connectionMode: "xiaomiCloud",
      hasCompletedOnboarding: true,
      miCloudRegion: "de",
      cachedXiaomiDevices: [],
    }));
    new MenuMijiaWindowsApp(element("#app"));
    assert.match(document.body.textContent ?? "", /当前地区（de）没有设备，可尝试切换地区/);

    await click("#btn-empty-settings");
    const select = document.querySelector<HTMLSelectElement>("select[data-mi-region]");
    assert.ok(select, "settings must offer the region dropdown");
    assert.deepEqual(
      Array.from(select!.options).map((option) => option.value),
      ["cn", "de", "i2", "ru", "sg", "us"],
    );
    assert.equal(select!.value, "de");

    select!.value = "us";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await setImmediate();
    const saved = JSON.parse(localStorage.getItem("menumijia.windows.settings.v2") ?? "{}") as { miCloudRegion?: string };
    assert.equal(saved.miCloudRegion, "us");
  });
});

describe("Windows personal edition", () => {
  it("starts with legacy assistant and updater preferences without contacting either service", async () => {
    const commands: string[] = [];
    const invoke = async (name: string) => {
      commands.push(name);
      return undefined;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({
      connectionMode: "demo",
      hasCompletedOnboarding: true,
      autoCheckUpdates: true,
      assistantBaseURL: "https://api.deepseek.com/v1",
      learnedShortcuts: [{ phrase: "关闭所有灯" }],
    }));
    new MenuMijiaWindowsApp(element("#app"));
    searchFor("关闭所有灯");
    await click("#btn-settings");
    for (const selector of ["#btn-mic", "#btn-grok-ball", "#command-input", "#settings-base-url", "#settings-auto-update", "#btn-install-update"]) {
      assert.equal(document.querySelector(selector), null);
    }
    assert.equal(commands.includes("native_http"), false);
    assert.equal(commands.includes("set_update_available"), false);
    assert.equal(commands.includes("install_update"), false);
  });

  it("resizes the native panel from a drag and persists the resulting logical dimensions", async () => {
    const sizes: Array<Record<string, unknown>> = [];
    const dragSizes: Array<Record<string, unknown>> = [];
    const invoke = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "set_panel_size") sizes.push(args);
      if (name === "resize_panel") {
        dragSizes.push(args);
        return [args.width, args.height];
      }
      return undefined;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({
      connectionMode: "demo", hasCompletedOnboarding: true, panelHeight: "tall",
    }));
    Object.defineProperties(window, {
      innerWidth: { value: 480, configurable: true },
      innerHeight: { value: 740, configurable: true },
    });
    const root = element("#app");
    new MenuMijiaWindowsApp(root);
    assert.deepEqual(sizes, [{ width: 480, height: 740, apply: true }]);
    const drag = (type: string, target: HTMLElement, screenX: number, screenY: number) => {
      target.dispatchEvent(new dom.PointerEvent(type, { button: 0, pointerId: 1, screenX, screenY, bubbles: true }) as unknown as Event);
    };
    drag("pointerdown", element("#panel-resize"), 500, 600);
    drag("pointermove", root, 410, 660);
    drag("pointerup", root, 410, 660);
    await waitFor(() => sizes.length === 2);
    assert.deepEqual(dragSizes.at(-1), { width: 570, height: 680 });
    assert.deepEqual(sizes[1], { width: 570, height: 680, apply: false });
    const saved = JSON.parse(localStorage.getItem("menumijia.windows.settings.v2") ?? "{}");
    assert.deepEqual(saved.panelSize, { width: 570, height: 680 });
    await click("#btn-settings");
    await click("#btn-reset-panel-size");
    assert.deepEqual(sizes[2], { width: 480, height: 620, apply: true });
  });
});

describe("Interface language and temperature units (#52)", () => {
  function seed(extra: Record<string, unknown>): void {
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({
      connectionMode: "demo",
      hasCompletedOnboarding: true,
      ...extra,
    }));
  }

  it("renders the English catalog when English is selected, and remembers it", async () => {
    seed({ interfaceLanguage: "en" });
    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();

    const text = document.body.textContent ?? "";
    assert.match(text, /All off/, "the hold-to-confirm control is translated");
    assert.match(text, /Switch home|My Mi Home|Living room/, "home and room labels are translated");
    assert.doesNotMatch(text, /全关/, "no Simplified Chinese chrome leaks into English mode");
    assert.match(element('[data-body-device="light.living_ceiling"]').textContent ?? "", /Living room ceiling light/i);

    // Selecting Chinese switches back without a reload and persists the choice.
    await click("#btn-settings");
    const chinese = document.querySelector<HTMLElement>('[data-interface-language="zh-Hans"]');
    assert.ok(chinese, "language picker is present in settings");
    await click('[data-interface-language="zh-Hans"]');
    assert.match(document.body.textContent ?? "", /全关/);
    const saved = JSON.parse(localStorage.getItem("menumijia.windows.settings.v2") ?? "{}") as Record<string, unknown>;
    assert.equal(saved["interfaceLanguage"], "zh-Hans");
  });

  it("follows the OS language when the preference is system", async () => {
    Object.defineProperty(window.navigator, "languages", { value: ["en-US", "en"], configurable: true });
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    seed({ interfaceLanguage: "system" });
    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();
    assert.match(document.body.textContent ?? "", /All off/);
  });

  it("shows °F when the unit is Fahrenheit, and one tap moves exactly one °F", async () => {
    seed({ interfaceLanguage: "zh-Hans", temperatureUnit: "fahrenheit" });
    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();

    // Demo AC runs at 25 °C = 77 °F; the sensor reads 25.5 °C = 77.9 °F.
    assert.match(textOf(".cc-climate"), /77°F/);
    assert.match(textOf(".cc-sensor"), /77\.9°F/);

    await click('[data-acstep="climate.living_ac:1"]');
    assert.match(textOf(".cc-climate"), /78°F/);
  });

  it("keeps Celsius when the unit is Celsius", async () => {
    seed({ interfaceLanguage: "zh-Hans", temperatureUnit: "celsius" });
    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();
    assert.match(textOf(".cc-climate"), /25°C/);
    assert.match(textOf(".cc-sensor"), /25\.5°C/);
  });
});

describe("Customizable global shortcut (#43)", () => {
  it("registers Alt+M by default, records a custom shortcut, persists it, and unregisters when disabled", async () => {
    const hotkeyCalls: Array<{ enabled: boolean; shortcut: string }> = [];
    const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      if (name === "set_global_shortcut") {
        hotkeyCalls.push({ enabled: Boolean(args["enabled"]), shortcut: String(args["shortcut"]) });
      }
      return undefined;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem(
      "menumijia.windows.settings.v2",
      JSON.stringify({
        connectionMode: "demo",
        hasCompletedOnboarding: true,
        interfaceLanguage: "zh-Hans",
      }),
    );

    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();
    assert.deepEqual(hotkeyCalls.at(-1), { enabled: true, shortcut: "Alt+M" });

    await click("#btn-settings");
    assert.equal(textOf("#btn-record-hotkey"), "Alt+M");

    // Arm the recorder; a plain letter without modifiers shows the hint and keeps listening.
    await click("#btn-record-hotkey");
    assert.equal(textOf("#btn-record-hotkey"), "按下组合…");
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "m", code: "KeyM", bubbles: true }));
    await setImmediate();
    assert.equal(textOf("#btn-record-hotkey"), "按下组合…");
    assert.ok(document.querySelector("#hotkey-record-hint"));

    // Press Ctrl+Alt+K -> records, persists, and calls set_global_shortcut.
    window.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
      }),
    );
    await setImmediate();
    assert.equal(textOf("#btn-record-hotkey"), "Ctrl+Alt+K");
    assert.deepEqual(hotkeyCalls.at(-1), { enabled: true, shortcut: "Ctrl+Alt+K" });
    const savedAfterRecord = JSON.parse(localStorage.getItem("menumijia.windows.settings.v2") ?? "{}") as Record<string, unknown>;
    assert.equal(savedAfterRecord["globalHotkey"], "Ctrl+Alt+K");

    // Reset button restores Alt+M.
    await click("#btn-reset-hotkey");
    await setImmediate();
    assert.equal(textOf("#btn-record-hotkey"), "Alt+M");
    assert.deepEqual(hotkeyCalls.at(-1), { enabled: true, shortcut: "Alt+M" });

    // Unchecking the toggle immediately unregisters the global shortcut (Coding Standard #3).
    const enableBox = element("#settings-enable-hotkey") as HTMLInputElement;
    enableBox.checked = false;
    enableBox.dispatchEvent(new window.Event("change", { bubbles: true }));
    await setImmediate();
    assert.deepEqual(hotkeyCalls.at(-1), { enabled: false, shortcut: "Alt+M" });
    assert.equal(document.querySelector("#btn-record-hotkey"), null);
  });

  it("surfaces a conflict notice when registration fails and clears it on retry", async () => {
    let shouldFail = true;
    const invoke = async (name: string): Promise<unknown> => {
      if (name === "set_global_shortcut" && shouldFail) {
        throw new Error("HotKey already registered");
      }
      return undefined;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem(
      "menumijia.windows.settings.v2",
      JSON.stringify({
        connectionMode: "demo",
        hasCompletedOnboarding: true,
        interfaceLanguage: "zh-Hans",
      }),
    );

    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();
    await click("#btn-settings");

    const conflictRow = document.querySelector("#hotkey-conflict-row");
    assert.ok(conflictRow, "conflict warning is shown in Settings");
    assert.match(conflictRow.textContent ?? "", /已被其他应用占用/);

    shouldFail = false;
    await click("#btn-retry-hotkey");
    await setImmediate();
    assert.equal(document.querySelector("#hotkey-conflict-row"), null);
  });
});

describe("Smart camera support and live view (#97)", () => {
  it("clicking a camera card opens the live stream window and supports night-shot, hot-hide reopen, timed teardown, motion detection, and undo", async () => {
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({
      connectionMode: "demo",
      hasCompletedOnboarding: true,
    }));
    const app = new MenuMijiaWindowsApp(element("#app"));
    assert.match(tile("camera.living_cam"), /监控中 · 自动夜视 · 侦测开 · 点击看画面/);

    // Clicking the camera card body opens the enlarged live camera view modal.
    await click('[data-body-device="camera.living_cam"]');
    assert.ok(document.querySelector(".cc-camera-live-sheet"), "live camera modal should open on click");
    assert.match(document.body.textContent ?? "", /实时看护小窗预览/);

    // Switch night vision mode inside the live modal and verify undo restores Auto.
    await click('[data-cameranight="camera.living_cam:On"]');
    assert.match(tile("camera.living_cam"), /夜视开/);

    // 「关闭画面」only hides the modal and keeps the session hot; reopening the card
    // brings it straight back (the camera needs a long cooldown before a used P2P
    // session can be re-negotiated, so full teardown waits for the keep-alive window).
    await click("#btn-close-camera-live");
    const backdropAfterClose = element(".cc-camera-live-sheet").closest(".cc-sheet-backdrop") as HTMLElement;
    assert.equal(backdropAfterClose.style.display, "none");
    await click('[data-body-device="camera.living_cam"]');
    const backdropAfterReopen = element(".cc-camera-live-sheet").closest(".cc-sheet-backdrop") as HTMLElement;
    assert.equal(backdropAfterReopen.style.display, "");
    assert.match(document.body.textContent ?? "", /实时看护小窗预览/);

    // When the keep-alive window expires with nobody watching, the modal is removed
    // entirely (on the real backend that teardown also stops the bridge and asks the
    // camera to release its P2P session; here we pin the window short and watch the DOM).
    app.cameraKeepAliveMs = 30;
    await click("#btn-close-camera-live");
    await waitFor(() => document.querySelector(".cc-camera-live-sheet") === null);

    await click("#btn-undo");
    assert.match(tile("camera.living_cam"), /自动夜视/);

    // Expand the camera drawer and toggle motion detection, then undo.
    await click('[data-expand-device="camera.living_cam"]');
    await click('[data-cameramotion="camera.living_cam"]');
    assert.doesNotMatch(tile("camera.living_cam"), /侦测开/);
    await click("#btn-undo");
    assert.match(tile("camera.living_cam"), /侦测开/);
  });

  it("persists custom camera stream URLs across restarts, rewrites local go2rtc m3u8 to mjpeg, and wakes sleeping cameras straight into the stream", async () => {
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({
      connectionMode: "demo",
      hasCompletedOnboarding: true,
    }));
    new MenuMijiaWindowsApp(element("#app"));
    await click('[data-body-device="camera.living_cam"]');
    await click("#btn-toggle-camera-url");
    const input = element("#camera-stream-url-input") as HTMLInputElement;
    input.value = "http://127.0.0.1:1984/api/stream.m3u8?src=living_custom";
    await click("#btn-save-camera-url");
    assert.equal(
      (element("#cc-camera-live-img") as HTMLImageElement).getAttribute("src"),
      "http://127.0.0.1:1984/api/stream.mjpeg?src=living_custom",
    );

    // Re-instantiate the app to verify the saved stream URL survived in localStorage.
    document.body.innerHTML = '<div id="app"></div>';
    new MenuMijiaWindowsApp(element("#app"));
    await click('[data-body-device="camera.living_cam"]');
    assert.equal(
      (element("#cc-camera-live-img") as HTMLImageElement).getAttribute("src"),
      "http://127.0.0.1:1984/api/stream.mjpeg?src=living_custom",
    );

    // Put the camera to sleep, then wake it from inside the modal and verify the stream resumes immediately.
    await click('.cc-camera-live-sheet .cc-segmented-pills [data-toggle-device="camera.living_cam"]');
    assert.match(document.body.textContent ?? "", /摄像机处于物理休眠状态/);
    await click('.cc-camera-stage.is-sleeping [data-toggle-device="camera.living_cam"]');
    assert.equal(
      (element("#cc-camera-live-img") as HTMLImageElement).getAttribute("src"),
      "http://127.0.0.1:1984/api/stream.mjpeg?src=living_custom",
    );
  });
});

describe("Air purifier support (#98)", () => {
  it("displays PM2.5, air quality, temperature/humidity, filter life, and supports mode & fan speed slider with undo", async () => {
    const rma3Spec = {
      type: "urn:miot-spec-v2:device:air-purifier:0000A007:zhimi-rma3:1",
      services: [
        {
          iid: 2,
          type: "urn:miot-spec-v2:service:air-purifier:00007811:zhimi-rma3:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:zhimi-rma3:1", format: "bool", access: ["read", "write"] },
            {
              iid: 4,
              type: "urn:miot-spec-v2:property:mode:00000008:zhimi-rma3:1",
              format: "uint8",
              access: ["read", "write"],
              valueList: [
                { value: 0, description: "Auto" },
                { value: 1, description: "Sleep" },
                { value: 2, description: "Favorite" },
              ],
            },
          ],
          actions: [],
        },
        {
          iid: 3,
          type: "urn:miot-spec-v2:service:environment:0000780A:zhimi-rma3:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:relative-humidity:0000000C:zhimi-rma3:1", format: "uint8", access: ["read"], valueRange: [0, 100, 1] },
            { iid: 4, type: "urn:miot-spec-v2:property:pm2.5-density:00000034:zhimi-rma3:1", format: "uint16", access: ["read"], valueRange: [0, 1000, 1] },
            { iid: 7, type: "urn:miot-spec-v2:property:temperature:00000020:zhimi-rma3:1", format: "float", access: ["read"], valueRange: [-30, 100, 1] },
            {
              iid: 8,
              type: "urn:miot-spec-v2:property:air-quality:0000001C:zhimi-rma3:1",
              format: "uint8",
              access: ["read"],
              valueList: [
                { value: 0, description: "Excellent" },
                { value: 1, description: "Good" },
              ],
            },
          ],
          actions: [],
        },
        {
          iid: 4,
          type: "urn:miot-spec-v2:service:filter:0000780B:zhimi-rma3:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:filter-life-level:0000001E:zhimi-rma3:1", format: "uint8", access: ["read"], valueRange: [0, 100, 1] },
          ],
          actions: [],
        },
        {
          iid: 11,
          type: "urn:miot-spec-v2:service:air-purifier-favorite:000078B2:zhimi-rma3:1",
          properties: [
            {
              iid: 1,
              type: "urn:miot-spec-v2:property:fan-level:00000016:zhimi-rma3:1",
              format: "uint8",
              access: ["read", "write"],
              valueList: Array.from({ length: 15 }, (_, i) => ({ value: i, description: `Level${i}` })),
            },
          ],
          actions: [],
        },
      ],
    };

    const state = new Map<string, unknown>([
      ["2.1", true],
      ["2.4", 0],
      ["11.1", 7],
      ["3.4", 18],
      ["3.8", 0],
      ["3.7", 24.5],
      ["3.1", 52],
      ["4.1", 86],
    ]);

    const security = "AQIDBAUGBwgJCgsMDQ4PEA==";
    const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      if (name !== "native_http") return undefined;
      const url = String(args["url"] ?? "");
      if (url.includes("/instance?")) {
        return { status: 200, headers: {}, body: JSON.stringify(rma3Spec) };
      }
      if (url.includes("/instances?")) {
        return { status: 200, headers: {}, body: JSON.stringify({ instances: [{ model: "zhimi.airp.rma3", type: rma3Spec.type }] }) };
      }
      let result: unknown = {};
      if (url.includes("device_list")) {
        result = {
          list: [{ did: "airp-rma3", name: "书房空气净化器", model: "zhimi.airp.rma3", isOnline: true, spec_type: rma3Spec.type }],
          has_more: false,
        };
      } else if (url.includes("homeroom/")) {
        result = { homelist: [{ id: "1", name: "家", dids: [], roomlist: [{ id: "10", name: "书房", dids: ["airp-rma3"] }] }] };
      } else if (url.includes("miotspec/prop/")) {
        const fields = new URLSearchParams(String(args["body"] ?? ""));
        const nonce = fields.get("_nonce") ?? "";
        const encrypted = fields.get("data") ?? "";
        const payload = JSON.parse(
          MiCloudCrypto.decryptResponse(encrypted, MiCloudCrypto.signedNonce(security, nonce))
        ) as { params?: Array<{ did: string; siid: number; piid: number; value?: unknown }> };
        result = (payload.params ?? []).map((p) => {
          if (url.includes("/set")) {
            state.set(`${p.siid}.${p.piid}`, p.value);
            return { did: p.did, siid: p.siid, piid: p.piid, code: 0 };
          }
          return { did: p.did, siid: p.siid, piid: p.piid, code: 0, value: state.get(`${p.siid}.${p.piid}`) };
        });
      }
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result }) };
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem(
      "menumijia.windows.settings.v2",
      JSON.stringify({
        connectionMode: "xiaomiCloud",
        hasCompletedOnboarding: true,
        miSession: { userId: "10001", cUserId: "", ssecurity: security, serviceToken: "tok", passToken: "", region: "cn" },
        cachedModelTypes: { "zhimi.airp.rma3": rma3Spec.type },
      }),
    );

    new MenuMijiaWindowsApp(element("#app"));
    await waitFor(() => Boolean(document.querySelector('[data-body-device="airp-rma3"]')));
    assert.match(tile("airp-rma3"), /运行中 · 自动 · 50% · PM2\.5 18 优 · 25°C 52%/);

    await click('[data-expand-device="airp-rma3"]');
    const drawerText = document.body.textContent ?? "";
    assert.match(drawerText, /空气质量 PM2\.5 18 \(优\)/);
    assert.match(drawerText, /温湿度 24\.5°C · 52%/);
    assert.match(drawerText, /滤芯余量 86%/);

    await setRange('[data-fanpercent="airp-rma3"]', "100");
    await waitFor(() => state.get("11.1") === 14);
    assert.equal(state.get("2.4"), 2);
    assert.match(tile("airp-rma3"), /最爱 · 100%/);

    await click("#btn-undo");
    await waitFor(() => state.get("11.1") === 7);
    assert.equal(state.get("2.4"), 0);
    assert.match(tile("airp-rma3"), /自动 · 50%/);
  });

  it("preserves sensor > purifier > climate priority in environment readings even when an air purifier precedes a sensor in device layout (#103)", async () => {
    const rma3Spec = {
      type: "urn:miot-spec-v2:device:air-purifier:0000A007:zhimi-rma3:1",
      services: [
        {
          iid: 2,
          type: "urn:miot-spec-v2:service:air-purifier:00007811:zhimi-rma3:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:zhimi-rma3:1", format: "bool", access: ["read", "write"] },
          ],
          actions: [],
        },
        {
          iid: 3,
          type: "urn:miot-spec-v2:service:environment:0000780A:zhimi-rma3:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:relative-humidity:0000000C:zhimi-rma3:1", format: "uint8", access: ["read"] },
            { iid: 7, type: "urn:miot-spec-v2:property:temperature:00000020:zhimi-rma3:1", format: "float", access: ["read"] },
          ],
          actions: [],
        },
      ],
    };
    const sensorSpec = {
      type: "urn:miot-spec-v2:device:temperature-humidity-sensor:0000A00A:miaomiaoce-t2:1",
      services: [
        {
          iid: 2,
          type: "urn:miot-spec-v2:service:temperature-humidity-sensor:00007814:miaomiaoce-t2:1",
          properties: [
            { iid: 1, type: "urn:miot-spec-v2:property:temperature:00000020:miaomiaoce-t2:1", format: "float", access: ["read"] },
            { iid: 2, type: "urn:miot-spec-v2:property:relative-humidity:0000000C:miaomiaoce-t2:1", format: "uint8", access: ["read"] },
          ],
          actions: [],
        },
      ],
    };

    const security = "AQIDBAUGBwgJCgsMDQ4PEA==";
    const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      if (name !== "native_http") return undefined;
      const url = String(args["url"] ?? "");
      if (url.includes("/instance?")) {
        const body = url.includes("temperature-humidity-sensor") ? sensorSpec : rma3Spec;
        return { status: 200, headers: {}, body: JSON.stringify(body) };
      }
      if (url.includes("/instances?")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            instances: [
              { model: "zhimi.airp.rma3", type: rma3Spec.type },
              { model: "miaomiaoce.sensor_ht.t2", type: sensorSpec.type },
            ],
          }),
        };
      }
      let result: unknown = {};
      if (url.includes("device_list")) {
        result = {
          list: [
            { did: "airp-rma3", name: "书房空净", model: "zhimi.airp.rma3", isOnline: true, spec_type: rma3Spec.type },
            { did: "sensor-t2", name: "客厅温湿度计", model: "miaomiaoce.sensor_ht.t2", isOnline: true, spec_type: sensorSpec.type },
          ],
          has_more: false,
        };
      } else if (url.includes("homeroom/")) {
        result = {
          homelist: [
            {
              id: "1",
              name: "家",
              dids: [],
              roomlist: [
                { id: "10", name: "书房", dids: ["airp-rma3"] },
                { id: "20", name: "客厅", dids: ["sensor-t2"] },
              ],
            },
          ],
        };
      } else if (url.includes("miotspec/prop/")) {
        const fields = new URLSearchParams(String(args["body"] ?? ""));
        const nonce = fields.get("_nonce") ?? "";
        const encrypted = fields.get("data") ?? "";
        const payload = JSON.parse(
          MiCloudCrypto.decryptResponse(encrypted, MiCloudCrypto.signedNonce(security, nonce))
        ) as { params?: Array<{ did: string; siid: number; piid: number }> };
        result = (payload.params ?? []).map((p) => {
          if (p.did === "airp-rma3") {
            const val = p.siid === 2 ? true : p.piid === 7 ? 26.5 : 48;
            return { did: p.did, siid: p.siid, piid: p.piid, code: 0, value: val };
          }
          const val = p.piid === 1 ? 22.0 : 55;
          return { did: p.did, siid: p.siid, piid: p.piid, code: 0, value: val };
        });
      }
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, result }) };
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem(
      "menumijia.windows.settings.v2",
      JSON.stringify({
        connectionMode: "xiaomiCloud",
        hasCompletedOnboarding: true,
        miSession: { userId: "10001", cUserId: "", ssecurity: security, serviceToken: "tok", passToken: "", region: "cn" },
        cachedModelTypes: {
          "zhimi.airp.rma3": rma3Spec.type,
          "miaomiaoce.sensor_ht.t2": sensorSpec.type,
        },
        layout: { order: ["airp-rma3", "sensor-t2"] },
      }),
    );

    new MenuMijiaWindowsApp(element("#app"));
    await waitFor(() => document.querySelectorAll(".cc-env-chip").length === 2);
    const chipLabels = Array.from(document.querySelectorAll(".cc-env-label"), (node) => node.textContent);
    assert.deepEqual(chipLabels, ["客厅", "书房空净"]);
  });

  it("reuses the outer popover element and clears is-opening so clicks do not replay the drop-in animation", async () => {
    startDemo();
    const root = element("#app");
    const initialPopover = element(".cc-popover");
    assert.equal(root.classList.contains("is-opening"), true);

    await click('[data-toggle-device="light.living_ceiling"]');
    assert.equal(root.classList.contains("is-opening"), false);
    assert.equal(element(".cc-popover"), initialPopover);
  });

  it("displays 0.5°C increments on every single AC step click in Celsius mode", async () => {
    localStorage.setItem(
      "menumijia.windows.settings.v2",
      JSON.stringify({
        connectionMode: "demo",
        hasCompletedOnboarding: true,
        interfaceLanguage: "zh-Hans",
        temperatureUnit: "celsius",
      }),
    );
    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();

    const tempEl = () => element(".cc-climate .cc-climate-temp");
    assert.equal(tempEl().textContent, "25°C");

    await click('[data-acstep="climate.living_ac:1"]');
    assert.equal(tempEl().textContent, "25.5°C");

    await click('[data-acstep="climate.living_ac:1"]');
    assert.equal(tempEl().textContent, "26°C");

    await click('[data-acstep="climate.living_ac:-1"]');
    assert.equal(tempEl().textContent, "25.5°C");

    await click('[data-acstep="climate.living_ac:-1"]');
    assert.equal(tempEl().textContent, "25°C");

    await click('[data-acstep="climate.living_ac:-1"]');
    assert.equal(tempEl().textContent, "24.5°C");
  });

  it("switches between light (daylight) and dark appearance in Settings and via the footer toggle", async () => {
    startDemo();
    const popover = () => element(".cc-popover");
    const startedLight = popover().classList.contains("scheme-light");

    // Quick toggle in the footer flips between Light (daylight) and Dark mode.
    await click("#btn-toggle-appearance");
    assert.equal(popover().classList.contains(startedLight ? "scheme-dark" : "scheme-light"), true);
    assert.equal(element("#app").dataset.scheme, startedLight ? "dark" : "light");

    // Settings sheet exposes System / Light / Dark segmented options.
    await click("#btn-settings");
    await click('[data-appearance="light"]');
    assert.equal(popover().classList.contains("scheme-light"), true);
    assert.equal(element("#app").dataset.scheme, "light");
    assert.equal(element('[data-appearance="light"]').getAttribute("aria-pressed"), "true");

    await click('[data-appearance="dark"]');
    assert.equal(popover().classList.contains("scheme-dark"), true);
    assert.equal(element("#app").dataset.scheme, "dark");
    assert.equal(element('[data-appearance="dark"]').getAttribute("aria-pressed"), "true");

    const saved = JSON.parse(localStorage.getItem("menumijia.windows.settings.v2") ?? "{}") as Record<string, unknown>;
    assert.equal(saved["appearance"], "dark");
  });

  it("renders bottom-right corner arc resize handles in layout edit mode and supports drag resizing and tap cycling without reordering (#115)", async () => {
    startDemo();
    const lightSelector = '[data-tile-id="light.living_ceiling"]';
    element(lightSelector).dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 80 }));
    await click("[data-start-editing]");

    assert.equal(element(".cc-popover").classList.contains("is-editing"), true);
    assert.equal(document.querySelectorAll(".cc-size-badge").length, 0, "Old top-right badge must be removed");

    const handleSelector = '.cc-resize-handle[data-cycle-size="light.living_ceiling"]';
    assert.equal(Boolean(element(handleSelector).querySelector("svg.cc-resize-arc path")), true, "Corner arc SVG path must be rendered inside .cc-resize-handle");
    assert.equal(element(handleSelector).getAttribute("data-tile-size"), "half");

    const readSavedSizes = (): Record<string, string> => {
      const raw = JSON.parse(localStorage.getItem("menumijia.windows.settings.v2") ?? "{}") as {
        layout?: { tileSizes?: Record<string, string> };
      };
      return raw.layout?.tileSizes ?? {};
    };
    const readSavedOrder = (): string[] => {
      const raw = JSON.parse(localStorage.getItem("menumijia.windows.settings.v2") ?? "{}") as {
        layout?: { order?: string[] };
      };
      return raw.layout?.order ?? [];
    };

    // 1. Outward drag on .cc-resize-handle: half -> full -> panel without starting card reorder.
    element(handleSelector).dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 160, clientY: 160 }));
    window.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientX: 220, clientY: 160 }));
    await setImmediate();
    assert.equal(readSavedSizes()["all|light.living_ceiling"], "full");
    assert.equal(element(lightSelector).classList.contains("is-dragging"), false, "Handle drag must not start card reorder drag");

    window.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientX: 220, clientY: 220 }));
    await setImmediate();
    assert.equal(readSavedSizes()["all|light.living_ceiling"], "panel");
    assert.equal(element(lightSelector).classList.contains("is-dragging"), false);

    window.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, clientX: 220, clientY: 220 }));
    await setImmediate();
    assert.deepEqual(readSavedOrder(), []);
    assert.equal(element(lightSelector).classList.contains("is-resizing"), false, "jiggle pause class must be cleaned up on release");
    assert.equal(element(handleSelector).classList.contains("is-active"), false, "handle emphasis must be cleaned up on release");

    // 2. Inward drag on .cc-resize-handle: panel -> full -> half without starting card reorder.
    element(handleSelector).dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 300, clientY: 260 }));
    window.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientX: 240, clientY: 260 }));
    await setImmediate();
    assert.equal(readSavedSizes()["all|light.living_ceiling"], "full");

    window.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientX: 240, clientY: 200 }));
    await setImmediate();
    assert.equal(readSavedSizes()["all|light.living_ceiling"], "half");

    window.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, clientX: 240, clientY: 200 }));
    await setImmediate();
    assert.deepEqual(readSavedOrder(), []);

    // 3. Light tap/click on .cc-resize-handle still cycles half -> full -> panel -> half.
    await click(handleSelector);
    assert.equal(readSavedSizes()["all|light.living_ceiling"], "full");
    await click(handleSelector);
    assert.equal(readSavedSizes()["all|light.living_ceiling"], "panel");
    await click(handleSelector);
    assert.equal(readSavedSizes()["all|light.living_ceiling"], "half");
  });
});

describe("Home Assistant source", () => {
  const fixture = JSON.parse(readFileSync("../Tests/Fixtures/ha_snapshot.json", "utf8"));
  function startHA(failedSnapshot = false, cached = failedSnapshot, token = "controlled-token"): { calls: string[]; failCommand: () => void } {
    const calls: string[] = [];
    let rejectCommand = false;
    const invoke = async (name: string) => {
      calls.push(name);
      if (name === "secure_store_get") return token;
      if (name === "ha_snapshot") {
        if (failedSnapshot) throw new Error("Home Assistant disconnected");
        return structuredClone(fixture);
      }
      if (name === "ha_execute" && rejectCommand) throw new Error("Home Assistant request failed");
      return undefined;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {value:{invoke},configurable:true});
    localStorage.setItem("menumijia.windows.settings.v2",JSON.stringify({connectionMode:"homeAssistant",haBaseURL:"http://localhost:8123",hasCompletedOnboarding:true,cachedHAHome:cached ? {endpoint:"http://localhost:8123",identity:homeAssistantIdentity("http://localhost:8123","controlled-token"),home:HomeAssistantSynthesizer.synthesize(fixture)} : null}));
    new MenuMijiaWindowsApp(element("#app"));
    return {calls,failCommand:() => {rejectCommand = true;}};
  }
  it("patches remote light power changes and all-off availability while keeping focused card nodes", async () => {
    let isOn = false;
    let snapshots = 0;
    let effects: string[] = [];
    const invoke = async (name: string) => {
      if (name === "secure_store_get") return "controlled-token";
      if (name === "ha_snapshot") {
        snapshots += 1;
        const next = structuredClone(fixture);
        next.states[0].state = isOn ? "on" : "off";
        next.states[0].attributes.effect_list = effects;
        return next;
      }
      return undefined;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({ connectionMode: "homeAssistant", haBaseURL: "http://localhost:8123", hasCompletedOnboarding: true }));
    new MenuMijiaWindowsApp(element("#app"));
    await waitFor(() => !!document.querySelector('[data-body-device="study-light"]'));
    await click('[data-expand-device="study-light"]');
    const searchInput = openSearch();
    const card = element('[data-tile-id="study-light"]');
    const input = element('[data-brightness="study-light"]');
    const scroll = element(".cc-scroll-area");
    const order = [...document.querySelectorAll<HTMLElement>("[data-tile-id]")].map((node) => node.dataset.tileId);
    scroll.scrollTop = 57;
    input.focus();
    assert.ok(!document.querySelector("#btn-all-off"));
    for (const power of [true, false, true]) {
      isOn = power;
      const before = snapshots;
      await click("#btn-refresh");
      await waitFor(() => snapshots === before + 1);
      assert.ok(element('[data-tile-id="study-light"]') === card, "Remote power must preserve the card node");
      assert.ok(element('[data-brightness="study-light"]') === input, "Remote power must preserve the slider node");
      assert.ok(element("#device-search") === searchInput);
      assert.ok(document.activeElement === input, "The focused slider must stay focused");
      assert.ok(element(".cc-scroll-area") === scroll);
      assert.equal(scroll.scrollTop, 57);
      assert.deepEqual([...document.querySelectorAll<HTMLElement>("[data-tile-id]")].map((node) => node.dataset.tileId), order);
      assert.equal(!!document.querySelector("#btn-all-off"), power);
      if (power) {
        assert.match(textOf("#btn-all-off"), /全关.*\(1\)/);
        assert.match(element("#btn-all-off").getAttribute("aria-label") ?? "", /1 台/);
      }
    }
    element("#btn-all-off").dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true }));
    await setImmediate();
    assert.match(textOf(".cc-feedback-text"), /关闭这 1 台/);
    effects = ["Day", "Night"];
    await click("#btn-refresh");
    assert.ok(document.querySelector('[data-lighteffect="study-light"][data-effect="Night"]'), "A genuine capability update must create its new controls");
  });
  it("keeps focused thermostat controls when remote heating mode changes", async () => {
    let mode = "off";
    const snapshot = JSON.parse(readFileSync("../Tests/Fixtures/ha_regressions.json", "utf8"));
    const invoke = async (name: string) => {
      if (name === "secure_store_get") return "controlled-token";
      if (name === "ha_snapshot") {
        const next = structuredClone(snapshot);
        next.states[0].state = mode;
        return next;
      }
      return undefined;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({ connectionMode: "homeAssistant", haBaseURL: "http://localhost:8123", hasCompletedOnboarding: true }));
    new MenuMijiaWindowsApp(element("#app"));
    await waitFor(() => !!document.querySelector('[data-tile-id="heat-only"]'));
    const searchInput = openSearch();
    const card = element('[data-tile-id="heat-only"]');
    const power = element('.cc-climate-power[data-toggle-device="heat-only"]');
    const step = element('[data-acstep="heat-only:1"]');
    const scroll = element(".cc-scroll-area");
    scroll.scrollTop = 41;
    step.focus();
    for (const nextMode of ["heat", "off", "heat"]) {
      mode = nextMode;
      await click("#btn-refresh");
      assert.ok(element('[data-tile-id="heat-only"]') === card, "A mode value change must preserve the thermostat card");
      assert.ok(element('.cc-climate-power[data-toggle-device="heat-only"]') === power);
      assert.ok(element('[data-acstep="heat-only:1"]') === step);
      assert.ok(element("#device-search") === searchInput);
      assert.ok(document.activeElement === step);
      assert.ok(element(".cc-scroll-area") === scroll);
      assert.equal(scroll.scrollTop, 41);
      assert.equal(power.getAttribute("aria-pressed"), String(mode === "heat"));
      assert.match(card.textContent ?? "", mode === "heat" ? /制热/ : /已关闭/);
    }
  });
  it("cleans old camera bearer URLs from current and legacy settings copies on startup and later writes", async () => {
    const snapshot = structuredClone(fixture);
    snapshot.states.push({ entity_id: "camera.front", state: "idle", attributes: { entity_picture: "/api/camera_proxy/camera.front?token=old-camera-bearer" } });
    const settings = { connectionMode: "demo", hasCompletedOnboarding: true, cachedHAHome: { identity: homeAssistantIdentity("http://localhost:8123", "account"), home: HomeAssistantSynthesizer.synthesize(snapshot) } };
    const credentialWrites: unknown[] = [];
    const invoke = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "secure_store_set") credentialWrites.push(args);
      return null;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    const keys = ["menumijia.windows.settings.v2", "menumijia.windows.settings.v1"];
    for (const key of keys) localStorage.setItem(key, JSON.stringify(settings));
    new MenuMijiaWindowsApp(element("#app"));
    await setImmediate();
    for (const key of keys) assert.equal(localStorage.getItem(key)?.includes("old-camera-bearer"), false);
    await click("#btn-toggle-appearance");
    for (const key of keys) assert.equal(localStorage.getItem(key)?.includes("camera_proxy"), false);
    assert.deepEqual(credentialWrites, [], "An expiring camera URL does not belong in the credential vault");
  });
  it("uses heat-only capability for card power and same-source undo", async () => {
    const snapshot = JSON.parse(readFileSync("../Tests/Fixtures/ha_regressions.json", "utf8"));
    const modes: unknown[] = [];
    const invoke = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "secure_store_get") return "controlled-token";
      if (name === "ha_snapshot") return snapshot;
      if (name === "ha_execute") {
        const call = args.command;
        assert.ok(call && typeof call === "object" && "data" in call);
        const data = call.data;
        assert.ok(data && typeof data === "object" && "hvac_mode" in data);
        modes.push(data.hvac_mode);
      }
      return undefined;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({ connectionMode: "homeAssistant", haBaseURL: "http://localhost:8123", hasCompletedOnboarding: true }));
    new MenuMijiaWindowsApp(element("#app"));
    await waitFor(() => !!document.querySelector('[data-toggle-device="heat-only"]'));
    await click('[data-toggle-device="heat-only"]');
    assert.deepEqual(modes, ["heat"]);
    await click('[data-toggle-device="heat-only"]');
    await click("#btn-undo");
    assert.deepEqual(modes, ["heat", "off", "heat"]);
  });
  it("retains cached cards and clears the independent HA error on reconnect", async () => {
    let failing = true;
    const invoke = async (name: string) => {
      if (name === "secure_store_get") return "controlled-token";
      if (name === "ha_snapshot") {
        if (failing) throw new Error("Connection lost");
        return fixture;
      }
      return undefined;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({ connectionMode: "homeAssistant", haBaseURL: "http://localhost:8123", hasCompletedOnboarding: true, cachedHAHome: { identity: homeAssistantIdentity("http://localhost:8123", "controlled-token"), home: HomeAssistantSynthesizer.synthesize(fixture) } }));
    new MenuMijiaWindowsApp(element("#app"));
    await waitFor(() => !!document.querySelector("[data-ha-error]"));
    assert.match(textOf("[data-ha-error]"), /Connection lost/);
    assert.match(tile("study-light"), /书房灯/);
    failing = false;
    await click("#btn-refresh");
    await waitFor(() => !document.querySelector("[data-ha-error]"));
    assert.match(tile("study-light"), /书房灯/);
  });
  it("rejects malformed cached HA homes and refreshes into an empty state", async () => {
    let snapshots = 0;
    const invoke = async (name: string) => {
      if (name === "secure_store_get") return "controlled-token";
      if (name === "ha_snapshot") { snapshots += 1; return structuredClone(fixture); }
      return undefined;
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({ connectionMode: "homeAssistant", haBaseURL: "http://localhost:8123", hasCompletedOnboarding: true, cachedHAHome: { identity: homeAssistantIdentity("http://localhost:8123", "controlled-token"), home: { devices: {}, rooms: [], environmentReadings: [], scenes: [] } } }));
    new MenuMijiaWindowsApp(element("#app"));
    await waitFor(() => !!document.querySelector('[data-body-device="study-light"]'));
    assert.equal(snapshots, 1);
  });
  for (const delayed of [false, true]) {
    it(`discards ${delayed ? "in-flight" : "completed"} undo after an HA account change`, async () => {
      const calls: Array<Record<string, unknown>> = [];
      let finish: () => void = () => {};
      const invoke = async (name: string, args: Record<string, unknown> = {}) => {
        if (name === "secure_store_get") return "account-a";
        if (name === "ha_snapshot") return structuredClone(fixture);
        if (name === "ha_execute") {
          calls.push(args);
          if (delayed) await new Promise<void>((resolve) => { finish = resolve; });
        }
        return undefined;
      };
      Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
      localStorage.setItem("menumijia.windows.settings.v2", JSON.stringify({ connectionMode: "homeAssistant", haBaseURL: "http://localhost:8123", hasCompletedOnboarding: true }));
      new MenuMijiaWindowsApp(element("#app"));
      await waitFor(() => !!document.querySelector('[data-body-device="study-light"]'));
      await click('[data-toggle-device="study-light"]');
      await waitFor(() => calls.length === 1);
      await click("#btn-settings");
      const token = document.querySelector<HTMLInputElement>("#settings-ha-token");
      assert.ok(token);
      token.value = "account-b";
      await click("#btn-save-settings");
      if (delayed) { finish(); await setImmediate(); }
      await waitFor(() => !!document.querySelector('[data-body-device="study-light"]'));
      assert.equal(document.querySelector("#btn-undo"), null);
      assert.equal(calls.length, 1, "Undo must not send account A's inverse to account B");
    });
  }
  it("connects without Xiaomi requests and keeps credentials out of settings", async () => {
    const {calls} = startHA();
    await waitFor(() => !!document.querySelector('[data-body-device="study-light"]'));
    assert.match(tile("study-light"), /书房灯/);
    assert.equal(calls.filter((call) => call === "ha_snapshot").length,1);
    assert.equal(calls.includes("native_http"),false);
    assert.equal(localStorage.getItem("menumijia.windows.settings.v2")?.includes("controlled-token"),false);
    assert.match(textOf('[data-ha-scene="scene.evening"]'), /晚安/);
    await click('[data-ha-scene="scene.evening"]');
    assert.ok(calls.includes("ha_execute"));
  });
  it("retains cached cards when a refresh fails", async () => {
    startHA(true);
    await waitFor(() => (document.body.textContent ?? "").includes("Home Assistant disconnected"));
    assert.match(tile("study-light"), /书房灯/);
  });
  it("shows HA refresh errors in the panel", async () => {
    startHA(true);
    await waitFor(() => !!document.querySelector("[data-ha-error]"));
    assert.match(textOf("[data-ha-error]"), /Home Assistant disconnected/);
  });
  it("keeps the confirmed light state after a failed service", async () => {
    const state = startHA();
    await waitFor(() => !!document.querySelector('[data-body-device="study-light"]'));
    state.failCommand();
    await click('[data-toggle-device="study-light"]');
    await waitFor(() => (document.body.textContent ?? "").includes("Home Assistant request failed"));
    assert.ok(state.calls.includes("ha_execute"));
    assert.match(tile("study-light"), /开启|50%|50 %/);
  });
  it("shows an empty HA home on initial failure without demo fallback", async () => {
    startHA(true, false);
    await waitFor(() => (document.body.textContent ?? "").includes("Home Assistant disconnected"));
    assert.equal(document.querySelectorAll("[data-body-device]").length,0);
  });
  it("does not show a previous account cache under a different token", async () => {
    startHA(true, true, "different-account-token");
    await waitFor(() => (document.body.textContent ?? "").includes("Home Assistant disconnected"));
    assert.equal(document.querySelectorAll("[data-body-device]").length,0);
  });
  it("does not apply an old HA snapshot after switching to demo", async () => {
    let complete: (value: unknown) => void = () => assert.fail("Snapshot has not started");
    let snapshots = 0;
    const invoke = async (name: string) => {
      if (name === "secure_store_get") return "controlled-token";
      if (name === "ha_snapshot") { snapshots += 1; return new Promise((resolve) => {complete = resolve;}); }
      return undefined;
    };
    Object.defineProperty(window,"__TAURI_INTERNALS__",{value:{invoke},configurable:true});
    localStorage.setItem("menumijia.windows.settings.v2",JSON.stringify({connectionMode:"homeAssistant",haBaseURL:"http://localhost:8123",hasCompletedOnboarding:true}));
    new MenuMijiaWindowsApp(element("#app"));
    await waitFor(() => snapshots === 1);
    await click("#btn-refresh");
    assert.equal(snapshots,1);
    await click("#btn-settings");
    await click('[data-conn-mode="demo"]');
    complete(fixture);
    await setImmediate();
    await click("#btn-close-settings");
    assert.equal(document.querySelector('[data-body-device="study-light"]'),null);
    assert.ok(document.querySelector('[data-body-device="light.living_ceiling"]'));
    assert.equal(snapshots,1);
  });
  it("patches HA value-only refreshes without replacing focused controls", async () => {
    let snapshots = 0;
    const invoke = async (name: string) => {
      if (name === "secure_store_get") return "controlled-token";
      if (name === "ha_snapshot") {
        snapshots += 1;
        const next = structuredClone(fixture);
        if (snapshots > 1) next.states[0].attributes.brightness = 200;
        return next;
      }
      return undefined;
    };
    Object.defineProperty(window,"__TAURI_INTERNALS__",{value:{invoke},configurable:true});
    localStorage.setItem("menumijia.windows.settings.v2",JSON.stringify({connectionMode:"homeAssistant",haBaseURL:"http://localhost:8123",hasCompletedOnboarding:true}));
    new MenuMijiaWindowsApp(element("#app"));
    await waitFor(() => !!document.querySelector('[data-body-device="study-light"]'));
    const input = openSearch();
    input.focus();
    const card = element('[data-body-device="study-light"]');
    await click("#btn-refresh");
    assert.equal(snapshots,2);
    assert.equal(element('[data-body-device="study-light"]'),card);
    assert.equal(document.activeElement,input);
    assert.match(tile("study-light"),/78%|78 %/);
  });
});
