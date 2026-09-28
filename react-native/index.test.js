"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
  };
}

function createPlugin(overrides = {}) {
  const calls = [];
  const plugin = {
    async setup(...args) {
      calls.push(["setup", ...args]);
    },
    async startSession(...args) {
      calls.push(["startSession", ...args]);
    },
    async endSession(...args) {
      calls.push(["endSession", ...args]);
    },
    async identify(...args) {
      calls.push(["identify", ...args]);
    },
    async reset(...args) {
      calls.push(["reset", ...args]);
    },
    async startRecording(...args) {
      calls.push(["startRecording", ...args]);
    },
    async stopRecording(...args) {
      calls.push(["stopRecording", ...args]);
    },
    async isEnabled() {
      calls.push(["isEnabled"]);
      return true;
    },
    ...overrides,
  };
  return { plugin, calls };
}

function loadClient({ plugin, appState = "active" }) {
  const listeners = new Set();
  const reactNative = {
    AppState: {
      currentState: appState,
      addEventListener(_event, listener) {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
    },
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
    NativeModules: { I18nManager: { localeIdentifier: "en_US" } },
    Platform: { OS: "ios", Version: "18.0" },
  };

  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "react-native") return reactNative;
    if (request === "@posthog/react-native-plugin") return plugin;
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve("./index.js");
  delete require.cache[modulePath];
  const { RybbitReactNative } = require(modulePath);
  Module._load = originalLoad;

  return {
    client: new RybbitReactNative(),
    emitAppState(nextState) {
      for (const listener of listeners) listener(nextState);
    },
    async changeAppState(nextState) {
      for (const listener of listeners) listener(nextState);
      await new Promise(resolve => setImmediate(resolve));
      await this.client.lifecyclePromise;
    },
  };
}

function createFetch(remoteConfig = { sessionReplay: true }) {
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "GET") {
      return { ok: true, json: async () => remoteConfig };
    }
    return { ok: true, status: 200 };
  };
  return { fetch, requests };
}

async function initClient(client, options = {}) {
  const storage = options.storage || createStorage();
  const network = createFetch(options.remoteConfig);
  await client.init({
    analyticsHost: "https://analytics.example.com/api/",
    siteId: "42",
    storage,
    fetch: network.fetch,
    initialScreenName: "",
    ...options.config,
  });
  return { storage, ...network };
}

test("configures native replay with a persisted UUID, private defaults, and the Rybbit endpoint", async () => {
  const { plugin, calls } = createPlugin();
  const { client } = loadClient({ plugin, appState: "active" });
  const { storage } = await initClient(client, {
    config: {
      sessionReplaySampleRate: 0.4,
      sessionReplayThrottleDelayMs: 250,
    },
  });

  const setup = calls.find(([name]) => name === "setup");
  assert.ok(setup);
  const [, sessionId, sdkOptions, pluginConfig] = setup;
  assert.match(sessionId, UUID_PATTERN);
  assert.equal(storage.values.get("@rybbit:42:replay-session-id"), sessionId);
  assert.deepEqual(sdkOptions, {
    apiKey: "42",
    projectToken: "42",
    host: "https://analytics.example.com/api",
    debug: false,
    distinctId: client.anonymousId,
    anonymousId: client.anonymousId,
    sdkVersion: "0.2.0",
    preloadFeatureFlags: false,
  });
  assert.deepEqual(pluginConfig, {
    sessionReplay: {
      enabled: true,
      sdkReplayConfig: {
        sampleRate: 0.4,
        maskAllTextInputs: true,
        maskAllImages: true,
        maskAllSandboxedViews: true,
        captureTouches: false,
        throttleDelayMs: 250,
        captureLog: false,
        captureNetworkTelemetry: false,
        screenshotModeBackgroundCapture: false,
      },
      decideReplayConfig: {
        endpoint: "https://analytics.example.com/api/session-replay/mobile/42",
      },
    },
  });
  assert.equal("maskAllText" in pluginConfig.sessionReplay.sdkReplayConfig, false);
});

test("correlates analytics payloads with the active replay session", async () => {
  const { plugin, calls } = createPlugin();
  const { client } = loadClient({ plugin, appState: "background" });
  const { requests } = await initClient(client);
  const sessionId = calls.find(([name]) => name === "setup")[1];

  await client.event("checkout_started");

  const payload = JSON.parse(requests.find(request => request.url.endsWith("/track")).options.body);
  assert.equal(payload.session_id, sessionId);
});

test("exposes replay controls and keeps native identity in sync", async () => {
  const { plugin, calls } = createPlugin();
  const { client } = loadClient({ plugin, appState: "active" });
  await initClient(client);

  await client.identify("user-7", { plan: "pro" });
  await client.stopSessionReplay();
  await client.startSessionReplay();
  assert.equal(await client.isSessionReplayActive(), true);
  await client.clearUserId();

  assert.ok(calls.some(call => call[0] === "identify" && call[1] === "user-7" && call[2] === client.anonymousId));
  assert.ok(calls.some(call => call[0] === "stopRecording"));
  assert.ok(calls.some(call => call[0] === "startRecording" && call[1] === true));
  assert.ok(calls.some(call => call[0] === "isEnabled"));
  assert.ok(calls.some(call => call[0] === "reset" && call[1] === client.anonymousId && call[2] === client.anonymousId));
});

test("stops and flushes replay in background, then resumes or rotates after the session timeout", async () => {
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const { plugin, calls } = createPlugin();
    const lifecycle = loadClient({ plugin, appState: "active" });
    await initClient(lifecycle.client, { config: { sessionReplaySessionTimeoutMs: 1000 } });
    const originalSessionId = calls.find(([name]) => name === "setup")[1];

    await lifecycle.changeAppState("background");
    assert.deepEqual(calls.slice(-2).map(call => call[0]), ["stopRecording", "endSession"]);

    now += 500;
    await lifecycle.changeAppState("active");
    assert.ok(calls.some(call => call[0] === "startSession" && call[1] === originalSessionId));
    assert.ok(calls.some(call => call[0] === "startRecording" && call[1] === true));

    await lifecycle.changeAppState("background");
    now += 1500;
    await lifecycle.changeAppState("active");
    const lastStartSession = calls.filter(call => call[0] === "startSession").at(-1);
    assert.match(lastStartSession[1], UUID_PATTERN);
    assert.notEqual(lastStartSession[1], originalSessionId);
    assert.deepEqual(calls.at(-1), ["startRecording", false]);
  } finally {
    Date.now = originalNow;
  }
});

test("disables replay gracefully in Expo Go and reports it from replay APIs", async () => {
  const linkingError = new Error("The package '@posthog/react-native-plugin' doesn't seem to be linked. You are not using Expo Go");
  const { plugin } = createPlugin({ setup: async () => Promise.reject(linkingError) });
  const { client } = loadClient({ plugin, appState: "background" });

  await initClient(client);

  await assert.rejects(client.startSessionReplay(), /not supported in Expo Go.*development build/i);
  assert.equal(await client.isSessionReplayActive(), false);
});

test("validates replay sample rate", async () => {
  const { plugin } = createPlugin();
  const { client } = loadClient({ plugin, appState: "background" });

  await assert.rejects(initClient(client, { config: { sessionReplaySampleRate: 1.1 } }), /between 0 and 1/);
});

test("does not resume replay after an explicit manual stop", async () => {
  const { plugin, calls } = createPlugin();
  const lifecycle = loadClient({ plugin, appState: "active" });
  await initClient(lifecycle.client);

  await lifecycle.client.stopSessionReplay();
  await lifecycle.changeAppState("background");
  await lifecycle.changeAppState("active");

  assert.equal(calls.filter(call => call[0] === "startRecording").length, 0);
});

test("stops replay before waiting for the background analytics request", async () => {
  let releaseBackgroundEvent;
  const { plugin, calls } = createPlugin();
  const lifecycle = loadClient({ plugin, appState: "active" });
  const fetch = async (_url, options = {}) => {
    if (options.method === "GET") return { ok: true, json: async () => ({ sessionReplay: true }) };
    const body = JSON.parse(options.body);
    if (body.event_name === "app_background") {
      return new Promise(resolve => {
        releaseBackgroundEvent = () => resolve({ ok: true, status: 200 });
      });
    }
    return { ok: true, status: 200 };
  };
  await lifecycle.client.init({ analyticsHost: "https://example.com/api", siteId: "42", fetch });

  lifecycle.emitAppState("background");
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(call => call[0] === "stopRecording"));
  assert.ok(calls.some(call => call[0] === "endSession"));

  releaseBackgroundEvent();
  await lifecycle.client.lifecyclePromise;
});

test("serializes rapid background and foreground replay transitions", async () => {
  let releaseStop;
  const { plugin, calls } = createPlugin({
    async stopRecording() {
      calls.push(["stopRecording"]);
      await new Promise(resolve => {
        releaseStop = resolve;
      });
    },
  });
  const lifecycle = loadClient({ plugin, appState: "active" });
  await initClient(lifecycle.client);

  lifecycle.emitAppState("background");
  lifecycle.emitAppState("active");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.some(call => call[0] === "startSession"), false);

  releaseStop();
  await lifecycle.client.lifecyclePromise;
  assert.ok(calls.some(call => call[0] === "startSession"));
});

test("reinitializing tears down replay and clears stale replay state", async () => {
  const { plugin, calls } = createPlugin();
  const { client } = loadClient({ plugin, appState: "background" });
  await initClient(client);

  await initClient(client, { remoteConfig: { sessionReplay: false } });

  assert.ok(calls.some(call => call[0] === "stopRecording"));
  assert.ok(calls.some(call => call[0] === "endSession"));
  assert.equal(client.replayConfigured, false);
  assert.equal(client.replaySessionId, null);
});

test("validates replay timing settings", async () => {
  const { plugin } = createPlugin();
  const { client } = loadClient({ plugin, appState: "background" });

  await assert.rejects(
    initClient(client, { config: { sessionReplayThrottleDelayMs: -1 } }),
    /sessionReplayThrottleDelayMs.*non-negative/
  );
  await assert.rejects(
    initClient(client, { config: { sessionReplaySessionTimeoutMs: Number.NaN } }),
    /sessionReplaySessionTimeoutMs.*non-negative/
  );
});

test("manual stop wins over an in-flight foreground resume", async () => {
  let releaseStartSession;
  const { plugin, calls } = createPlugin({
    async startSession(sessionId) {
      calls.push(["startSession", sessionId]);
      await new Promise(resolve => {
        releaseStartSession = resolve;
      });
    },
  });
  const lifecycle = loadClient({ plugin, appState: "active" });
  await initClient(lifecycle.client);
  await lifecycle.changeAppState("background");

  lifecycle.emitAppState("active");
  await new Promise(resolve => setImmediate(resolve));
  const stopPromise = lifecycle.client.stopSessionReplay();
  releaseStartSession();
  await stopPromise;
  await lifecycle.client.lifecyclePromise;

  assert.equal(calls.filter(call => call[0] === "startRecording").length, 0);
});

test("replay lifecycle still stops recording when analytics lifecycle events are disabled", async () => {
  const { plugin, calls } = createPlugin();
  const lifecycle = loadClient({ plugin, appState: "active" });
  const { requests } = await initClient(lifecycle.client, { config: { autoTrackAppLifecycle: false } });

  await lifecycle.changeAppState("background");

  assert.ok(calls.some(call => call[0] === "stopRecording"));
  const eventNames = requests
    .filter(request => request.url.endsWith("/track"))
    .map(request => JSON.parse(request.options.body).event_name);
  assert.deepEqual(eventNames, []);
});

test("manual start restarts a native session that backgrounding ended", async () => {
  const { plugin, calls } = createPlugin();
  const lifecycle = loadClient({ plugin, appState: "active" });
  await initClient(lifecycle.client);

  await lifecycle.client.stopSessionReplay();
  await lifecycle.changeAppState("background");
  await lifecycle.changeAppState("active");
  const callCount = calls.length;
  await lifecycle.client.startSessionReplay();

  assert.deepEqual(calls.slice(callCount).map(call => call[0]), ["startSession", "startRecording"]);
});

test("cleanup stops and ends native replay", async () => {
  const { plugin, calls } = createPlugin();
  const { client } = loadClient({ plugin, appState: "background" });
  await initClient(client);

  await client.cleanup();

  assert.deepEqual(calls.slice(-2).map(call => call[0]), ["stopRecording", "endSession"]);
});

test("manual stop cancels a pending manual restart before recording begins", async () => {
  let releaseStartSession;
  const { plugin, calls } = createPlugin({
    async startSession(sessionId) {
      calls.push(["startSession", sessionId]);
      await new Promise(resolve => {
        releaseStartSession = resolve;
      });
    },
  });
  const lifecycle = loadClient({ plugin, appState: "active" });
  await initClient(lifecycle.client);
  await lifecycle.client.stopSessionReplay();
  await lifecycle.changeAppState("background");
  await lifecycle.changeAppState("active");

  const startPromise = lifecycle.client.startSessionReplay();
  await new Promise(resolve => setImmediate(resolve));
  const stopPromise = lifecycle.client.stopSessionReplay();
  releaseStartSession();
  await Promise.all([startPromise, stopPromise]);

  assert.equal(calls.filter(call => call[0] === "startRecording").length, 0);
});

test("does not manually start native recording while the app is backgrounded", async () => {
  const { plugin, calls } = createPlugin();
  const lifecycle = loadClient({ plugin, appState: "background" });
  await initClient(lifecycle.client);
  await lifecycle.client.stopSessionReplay();
  const callCount = calls.length;

  await lifecycle.client.startSessionReplay();

  assert.equal(calls.slice(callCount).some(call => call[0] === "startRecording"), false);
});

test("serializes concurrent identify and reset operations", async () => {
  let releaseIdentify;
  const { plugin, calls } = createPlugin({
    async identify(...args) {
      await new Promise(resolve => {
        releaseIdentify = resolve;
      });
      calls.push(["identify", ...args]);
    },
  });
  const { client } = loadClient({ plugin, appState: "background" });
  await initClient(client);

  const identifyPromise = client.identify("user-9");
  await new Promise(resolve => setImmediate(resolve));
  const resetPromise = client.clearUserId();
  releaseIdentify();
  await Promise.all([identifyPromise, resetPromise]);

  assert.deepEqual(
    calls.filter(call => call[0] === "identify" || call[0] === "reset").map(call => call[0]),
    ["identify", "reset"]
  );
  assert.equal(client.getUserId(), null);
});

test("does not attach replay correlation when the native plugin is unavailable", async () => {
  const linkingError = new Error("The package '@posthog/react-native-plugin' doesn't seem to be linked. You are not using Expo Go");
  const { plugin } = createPlugin({ setup: async () => Promise.reject(linkingError) });
  const { client } = loadClient({ plugin, appState: "background" });
  const { requests } = await initClient(client);

  await client.event("safe_event");

  const payload = JSON.parse(requests.find(request => request.url.endsWith("/track")).options.body);
  assert.equal("session_id" in payload, false);
});

test("published files include the test target declared by package scripts", () => {
  const packageMetadata = require("./package.json");
  assert.ok(packageMetadata.files.includes("index.test.js"));
});
