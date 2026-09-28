"use strict";

const SDK_VERSION = "0.2.0";
const DEFAULT_CONFIG_TIMEOUT_MS = 3000;
const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_REPLAY_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

let ReactNativeModule;
try {
  ReactNativeModule = require("react-native");
} catch {
  ReactNativeModule = null;
}
let SessionReplayPlugin;
try {
  SessionReplayPlugin = require("@posthog/react-native-plugin");
  SessionReplayPlugin = SessionReplayPlugin.default || SessionReplayPlugin;
} catch {
  SessionReplayPlugin = null;
}

function getReactNative() {
  if (!ReactNativeModule) {
    ReactNativeModule = require("react-native");
  }
  return ReactNativeModule;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function createMemoryStorage() {
  const values = new Map();
  return {
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

function generateId() {
  const randomPart = Math.random().toString(36).slice(2);
  const timePart = Date.now().toString(36);
  return `rn_${timePart}_${randomPart}`;
}

function generateUuid() {
  const cryptoObject = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (typeof cryptoObject?.randomUUID === "function") return cryptoObject.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoObject?.getRandomValues === "function") {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
    .slice(8, 10)
    .join("")}-${hex.slice(10).join("")}`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function isNativeReplayLinkingError(error) {
  const message = String(error?.message || error || "");
  return message.includes("doesn't seem to be linked") || message.includes("Expo Go");
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function asPathname(path) {
  if (!path) return "/";
  const value = String(path).trim();
  if (!value) return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

function getLanguage() {
  try {
    const { NativeModules, Platform } = getReactNative();
    if (Platform.OS === "ios") {
      const settings = NativeModules.SettingsManager?.settings || {};
      return settings.AppleLocale || settings.AppleLanguages?.[0] || "";
    }
    return NativeModules.I18nManager?.localeIdentifier || "";
  } catch {
    return "";
  }
}

function getScreenSize() {
  try {
    const { Dimensions } = getReactNative();
    const screen = Dimensions.get("screen");
    return {
      screenWidth: Math.max(1, Math.round(screen.width || 0)),
      screenHeight: Math.max(1, Math.round(screen.height || 0)),
    };
  } catch {
    return {
      screenWidth: 1,
      screenHeight: 1,
    };
  }
}

function getUserAgent(appVersion) {
  try {
    const { Platform } = getReactNative();
    if (Platform.OS === "android") {
      const version = Platform.Version || "";
      return `Mozilla/5.0 (Linux; Android ${version}) AppleWebKit/537.36 (KHTML, like Gecko) RybbitReactNative/${SDK_VERSION}${appVersion ? ` ${appVersion}` : ""}`;
    }
    if (Platform.OS === "ios") {
      const version = String(Platform.Version || "").replace(/\./g, "_");
      return `Mozilla/5.0 (iPhone; CPU iPhone OS ${version} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) RybbitReactNative/${SDK_VERSION}${appVersion ? ` ${appVersion}` : ""}`;
    }
    return `RybbitReactNative/${SDK_VERSION} (${Platform.OS})${appVersion ? ` ${appVersion}` : ""}`;
  } catch {
    return `RybbitReactNative/${SDK_VERSION}`;
  }
}

function normalizeAcceptLanguage(language) {
  const fallback = "en-US,en;q=0.9";
  const value = String(language || "").trim();
  if (!value) return fallback;

  const primaryLanguage = value.replace(/_/g, "-").split(/[;,]/)[0].trim();
  return primaryLanguage || fallback;
}

function createRequestHeaders(payload) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Language": normalizeAcceptLanguage(payload?.language),
  };

  if (payload?.user_agent) {
    headers["User-Agent"] = payload.user_agent;
  }

  return headers;
}

class RybbitReactNative {
  constructor() {
    this.config = null;
    this.remoteConfig = {};
    this.storage = createMemoryStorage();
    this.anonymousId = null;
    this.userId = null;
    this.queue = [];
    this.appStateSubscription = null;
    this.replayPlugin = SessionReplayPlugin;
    this.replaySessionId = null;
    this.replayConfigured = false;
    this.replayUnsupported = false;
    this.replayLastBackgroundAt = null;
    this.replayManuallyStopped = false;
    this.replaySessionEnded = false;
    this.replayControlVersion = 0;
    this.lifecyclePromise = Promise.resolve();
    this.identityPromise = Promise.resolve();
    this.currentAppState = "unknown";
  }

  async init(config) {
    if (!config || !config.analyticsHost || !config.siteId) {
      throw new Error("analyticsHost and siteId are required");
    }

    const replaySampleRate = config.sessionReplaySampleRate ?? 1;
    if (typeof replaySampleRate !== "number" || !Number.isFinite(replaySampleRate) || replaySampleRate < 0 || replaySampleRate > 1) {
      throw new Error("sessionReplaySampleRate must be a number between 0 and 1");
    }
    const replayThrottleDelayMs = config.sessionReplayThrottleDelayMs ?? 1000;
    if (typeof replayThrottleDelayMs !== "number" || !Number.isFinite(replayThrottleDelayMs) || replayThrottleDelayMs < 0) {
      throw new Error("sessionReplayThrottleDelayMs must be a finite non-negative number");
    }
    const replaySessionTimeoutMs = config.sessionReplaySessionTimeoutMs ?? DEFAULT_REPLAY_SESSION_TIMEOUT_MS;
    if (typeof replaySessionTimeoutMs !== "number" || !Number.isFinite(replaySessionTimeoutMs) || replaySessionTimeoutMs < 0) {
      throw new Error("sessionReplaySessionTimeoutMs must be a finite non-negative number");
    }

    await this.teardownSessionReplay();

    this.config = {
      analyticsHost: trimTrailingSlash(config.analyticsHost),
      siteId: String(config.siteId),
      appIdentifier: config.appIdentifier || config.bundleId || "",
      appVersion: config.appVersion || "",
      tag: config.tag || "",
      storageKeyPrefix: config.storageKeyPrefix || "@rybbit",
      debug: !!config.debug,
      autoTrackAppLifecycle: config.autoTrackAppLifecycle !== false,
      initialScreenName: config.initialScreenName || "",
      configTimeoutMs: config.configTimeoutMs || DEFAULT_CONFIG_TIMEOUT_MS,
      maxQueueSize: config.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE,
      fetch: config.fetch || (typeof fetch === "function" ? fetch : undefined),
      sessionReplaySampleRate: replaySampleRate,
      sessionReplayMaskAllTextInputs: config.sessionReplayMaskAllTextInputs !== false,
      sessionReplayMaskAllImages: config.sessionReplayMaskAllImages !== false,
      sessionReplayMaskAllSandboxedViews: config.sessionReplayMaskAllSandboxedViews !== false,
      sessionReplayCaptureTouches: config.sessionReplayCaptureTouches === true,
      sessionReplayThrottleDelayMs: replayThrottleDelayMs,
      sessionReplaySessionTimeoutMs: replaySessionTimeoutMs,
    };
    this.storage = config.storage || createMemoryStorage();

    this.anonymousId = await this.getOrCreateAnonymousId();
    this.userId = await this.storage.getItem(this.storageKey("user-id"));
    this.remoteConfig = await this.fetchRemoteConfig();
    await this.setupSessionReplay();

    if (this.config.autoTrackAppLifecycle || this.replayConfigured) {
      this.setupAppLifecycleTracking();
    }

    if (this.config.initialScreenName && this.remoteConfig.trackInitialPageView !== false) {
      await this.screen(this.config.initialScreenName);
    }

    await this.flush();
  }

  async teardownSessionReplay() {
    this.appStateSubscription?.remove?.();
    this.appStateSubscription = null;
    await this.lifecyclePromise;
    await this.identityPromise;
    if (this.replayConfigured) {
      await this.replayPlugin.stopRecording();
      await this.replayPlugin.endSession();
    }
    this.replaySessionId = null;
    this.replayConfigured = false;
    this.replayUnsupported = false;
    this.replayLastBackgroundAt = null;
    this.replayManuallyStopped = false;
    this.replaySessionEnded = false;
    this.replayControlVersion = 0;
    this.lifecyclePromise = Promise.resolve();
  }

  storageKey(name) {
    return `${this.config.storageKeyPrefix}:${this.config.siteId}:${name}`;
  }

  async getOrCreateAnonymousId() {
    const key = this.storageKey("anonymous-id");
    const existing = await this.storage.getItem(key);
    if (existing) return existing;

    const nextId = generateId();
    await this.storage.setItem(key, nextId);
    return nextId;
  }

  async getOrCreateReplaySessionId() {
    const idKey = this.storageKey("replay-session-id");
    const activityKey = this.storageKey("replay-last-activity-at");
    const existingId = await this.storage.getItem(idKey);
    const lastActivity = Number(await this.storage.getItem(activityKey));
    const isCurrent =
      isUuid(existingId) &&
      Number.isFinite(lastActivity) &&
      lastActivity > 0 &&
      Date.now() - lastActivity <= this.config.sessionReplaySessionTimeoutMs;
    const sessionId = isCurrent ? existingId : generateUuid();
    await this.storage.setItem(idKey, sessionId);
    await this.storage.setItem(activityKey, String(Date.now()));
    return sessionId;
  }

  async setupSessionReplay() {
    if (this.remoteConfig.sessionReplay !== true || this.config.sessionReplaySampleRate === 0) return;

    this.replaySessionId = await this.getOrCreateReplaySessionId();
    if (!this.replayPlugin) {
      this.replayUnsupported = true;
      this.debug("Native session replay is unavailable. Expo Go is not supported; use a development build.");
      return;
    }

    try {
      this.currentAppState = getReactNative().AppState?.currentState || "unknown";
      await this.replayPlugin.setup(
        this.replaySessionId,
        {
          apiKey: this.config.siteId,
          projectToken: this.config.siteId,
          host: this.config.analyticsHost,
          debug: this.config.debug,
          distinctId: this.userId || this.anonymousId,
          anonymousId: this.anonymousId,
          sdkVersion: SDK_VERSION,
          preloadFeatureFlags: false,
        },
        {
          sessionReplay: {
            enabled: this.currentAppState === "active",
            sdkReplayConfig: {
              sampleRate: this.config.sessionReplaySampleRate,
              maskAllTextInputs: this.config.sessionReplayMaskAllTextInputs,
              maskAllImages: this.config.sessionReplayMaskAllImages,
              maskAllSandboxedViews: this.config.sessionReplayMaskAllSandboxedViews,
              captureTouches: this.config.sessionReplayCaptureTouches,
              throttleDelayMs: this.config.sessionReplayThrottleDelayMs,
              captureLog: false,
              captureNetworkTelemetry: false,
              screenshotModeBackgroundCapture: false,
            },
            decideReplayConfig: {
              endpoint: `${this.config.analyticsHost}/session-replay/mobile/${this.config.siteId}`,
            },
          },
        }
      );
      this.replayConfigured = true;
      this.replaySessionEnded = false;
    } catch (error) {
      if (isNativeReplayLinkingError(error)) {
        this.replayUnsupported = true;
        this.debug("Native session replay is not supported in Expo Go. Use an Expo development build.", error);
        return;
      }
      throw error;
    }
  }

  async fetchRemoteConfig() {
    try {
      const response = await withTimeout(
        this.config.fetch(`${this.config.analyticsHost}/site/tracking-config/${this.config.siteId}`, {
          method: "GET",
        }),
        this.config.configTimeoutMs
      );
      if (!response.ok) return {};
      return await response.json();
    } catch (error) {
      this.debug("Failed to fetch tracking config", error);
      return {};
    }
  }

  setupAppLifecycleTracking() {
    try {
      const { AppState } = getReactNative();
      let previousState = AppState.currentState;
      this.currentAppState = previousState;

      if (previousState === "active" && this.config.autoTrackAppLifecycle) {
        this.event("app_open").catch(error => this.debug("Failed to track app_open", error));
      }

      this.appStateSubscription?.remove?.();
      this.appStateSubscription = AppState.addEventListener("change", nextState => {
        const priorState = previousState;
        previousState = nextState;
        this.currentAppState = nextState;
        const transition = () => this.handleAppStateChange(priorState, nextState);
        this.lifecyclePromise = this.lifecyclePromise.then(transition, transition).catch(error => {
          this.debug("Failed to handle AppState change", error);
        });
      });
    } catch (error) {
      this.debug("Failed to setup AppState tracking", error);
    }
  }

  async handleAppStateChange(previousState, nextState) {
    if (previousState !== "active" && nextState === "active") {
      await this.resumeSessionReplay();
      if (this.config.autoTrackAppLifecycle) await this.event("app_open");
    } else if (previousState === "active" && nextState !== "active") {
      await this.pauseSessionReplay();
      if (this.config.autoTrackAppLifecycle) await this.event("app_background", { state: nextState });
    }
  }

  async pauseSessionReplay() {
    if (!this.replayConfigured) return;
    this.replayLastBackgroundAt = Date.now();
    await this.storage.setItem(this.storageKey("replay-last-activity-at"), String(this.replayLastBackgroundAt));
    await this.replayPlugin.stopRecording();
    await this.replayPlugin.endSession();
    this.replaySessionEnded = true;
  }

  async resumeSessionReplay() {
    if (!this.replayConfigured || this.replayManuallyStopped) return;
    const elapsed = this.replayLastBackgroundAt === null ? 0 : Date.now() - this.replayLastBackgroundAt;
    const resumeCurrent = elapsed <= this.config.sessionReplaySessionTimeoutMs;
    if (!resumeCurrent) {
      this.replaySessionId = generateUuid();
      await this.storage.setItem(this.storageKey("replay-session-id"), this.replaySessionId);
    }
    await this.storage.setItem(this.storageKey("replay-last-activity-at"), String(Date.now()));
    await this.replayPlugin.startSession(this.replaySessionId);
    this.replaySessionEnded = false;
    if (this.replayManuallyStopped) return;
    await this.replayPlugin.startRecording(resumeCurrent);
  }

  createBasePayload(context) {
    this.ensureInitialized();
    const screenSize = getScreenSize();
    const appIdentifier = context?.appIdentifier || this.config.appIdentifier || this.config.siteId;

    const payload = {
      site_id: this.config.siteId,
      anonymous_id: this.anonymousId,
      hostname: appIdentifier,
      pathname: asPathname(context?.pathname || context?.screen || "/"),
      querystring: context?.querystring || "",
      screenWidth: screenSize.screenWidth,
      screenHeight: screenSize.screenHeight,
      language: context?.language || getLanguage(),
      page_title: context?.title || context?.screen || "",
      referrer: context?.referrer || "",
      user_agent: context?.userAgent || getUserAgent(this.config.appVersion),
    };

    if (this.userId) payload.user_id = this.userId;
    if (this.replayConfigured && this.replaySessionId) payload.session_id = this.replaySessionId;
    if (this.config.tag) payload.tag = this.config.tag;

    return payload;
  }

  async send(payload) {
    this.ensureInitialized();
    try {
      const response = await this.config.fetch(`${this.config.analyticsHost}/track`, {
        method: "POST",
        headers: createRequestHeaders(payload),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Tracking request failed with ${response.status}`);
      }
    } catch (error) {
      this.enqueue(payload);
      this.debug("Failed to send tracking payload", error);
    }
  }

  enqueue(payload) {
    this.queue.push(payload);
    if (this.queue.length > this.config.maxQueueSize) {
      this.queue.shift();
    }
  }

  async flush() {
    this.ensureInitialized();
    if (this.queue.length === 0) return;

    const queued = [...this.queue];
    this.queue = [];
    for (const payload of queued) {
      await this.send(payload);
    }
  }

  async track(type, eventName, properties, context) {
    const payload = {
      ...this.createBasePayload(context),
      type,
      event_name: eventName || "",
    };

    if (properties && Object.keys(properties).length > 0) {
      payload.properties = JSON.stringify(properties);
    }

    await this.send(payload);
  }

  async screen(name, properties, context) {
    const pathname = context?.pathname || asPathname(name);
    await this.track("pageview", "", properties, {
      ...context,
      screen: name,
      pathname,
      title: context?.title || name,
    });
  }

  async pageview(path, context) {
    await this.track("pageview", "", undefined, {
      ...context,
      pathname: path || context?.pathname || "/",
      title: context?.title || "",
    });
  }

  async event(name, properties, context) {
    if (!name || typeof name !== "string") {
      throw new Error("Event name is required and must be a string");
    }
    await this.track("custom_event", name, properties || {}, context);
  }

  async error(error, properties, context) {
    if (this.remoteConfig.trackErrors === false) return;
    const err = error instanceof Error ? error : new Error(String(error));
    await this.track(
      "error",
      err.name || "Error",
      {
        message: String(err.message || "Unknown error").slice(0, 500),
        stack: String(err.stack || "").slice(0, 2000),
        ...(properties || {}),
      },
      context
    );
  }

  enqueueIdentityOperation(operation) {
    const result = this.identityPromise.then(operation, operation);
    this.identityPromise = result.catch(error => {
      this.debug("Failed to update identity", error);
    });
    return result;
  }

  async identify(userId, traits) {
    this.ensureInitialized();
    if (!userId || typeof userId !== "string" || !userId.trim()) {
      throw new Error("User ID must be a non-empty string");
    }

    const nextUserId = userId.trim();
    await this.enqueueIdentityOperation(async () => {
      this.userId = nextUserId;
      await this.storage.setItem(this.storageKey("user-id"), this.userId);

      if (this.replayConfigured) {
        await this.replayPlugin.identify(this.userId, this.anonymousId);
      }

      await this.sendIdentify(this.userId, traits, true);
    });
  }

  async setTraits(traits) {
    this.ensureInitialized();
    await this.enqueueIdentityOperation(async () => {
      if (!this.userId) {
        throw new Error("Cannot set traits without identifying user first");
      }
      await this.sendIdentify(this.userId, traits || {}, false);
    });
  }

  async sendIdentify(userId, traits, isNewIdentify) {
    const userAgent = getUserAgent(this.config.appVersion);
    try {
      const response = await this.config.fetch(`${this.config.analyticsHost}/identify`, {
        method: "POST",
        headers: createRequestHeaders({
          language: getLanguage(),
          user_agent: userAgent,
        }),
        body: JSON.stringify({
          site_id: this.config.siteId,
          anonymous_id: this.anonymousId,
          user_id: userId,
          traits,
          is_new_identify: isNewIdentify,
          user_agent: userAgent,
        }),
      });

      if (!response.ok) {
        throw new Error(`Identify request failed with ${response.status}`);
      }
    } catch (error) {
      this.debug("Failed to send identify payload", error);
    }
  }

  async clearUserId() {
    this.ensureInitialized();
    await this.enqueueIdentityOperation(async () => {
      this.userId = null;
      await this.storage.removeItem(this.storageKey("user-id"));
      if (this.replayConfigured) {
        await this.replayPlugin.reset(this.anonymousId, this.anonymousId);
      }
    });
  }

  getUserId() {
    return this.userId;
  }

  ensureSessionReplayAvailable() {
    this.ensureInitialized();
    if (this.replayUnsupported) {
      throw new Error("Native session replay is not supported in Expo Go. Use an Expo development build or a native build.");
    }
    if (!this.replayConfigured) {
      throw new Error("Session replay is not enabled for this site or its sample rate is 0");
    }
  }

  enqueueLifecycleOperation(operation) {
    const result = this.lifecyclePromise.then(operation, operation);
    this.lifecyclePromise = result.catch(error => {
      this.debug("Failed to update native session replay", error);
    });
    return result;
  }

  async startSessionReplay() {
    this.ensureSessionReplayAvailable();
    const operationVersion = ++this.replayControlVersion;
    await this.enqueueLifecycleOperation(async () => {
      if (operationVersion !== this.replayControlVersion) return;
      this.replayManuallyStopped = false;
      if (this.currentAppState !== "active") return;
      if (this.replaySessionEnded) {
        await this.replayPlugin.startSession(this.replaySessionId);
        this.replaySessionEnded = false;
      }
      if (operationVersion !== this.replayControlVersion || this.replayManuallyStopped) return;
      await this.replayPlugin.startRecording(true);
    });
  }

  async stopSessionReplay() {
    this.ensureSessionReplayAvailable();
    this.replayControlVersion += 1;
    this.replayManuallyStopped = true;
    await this.enqueueLifecycleOperation(() => this.replayPlugin.stopRecording());
  }

  async isSessionReplayActive() {
    this.ensureInitialized();
    if (!this.replayConfigured) return false;
    await this.lifecyclePromise;
    return !!(await this.replayPlugin.isEnabled());
  }

  createNavigationTracker(options) {
    let previousRouteName = null;
    const client = this;
    const getRouteName = options?.getRouteName || (route => route?.name || "");
    const getPath = options?.getPath || (route => route?.path || route?.name || "");
    const includeRouteParams = !!options?.includeRouteParams;

    const trackCurrentRoute = async navigationRef => {
      const route = navigationRef?.getCurrentRoute?.();
      const routeName = getRouteName(route);
      if (!routeName || routeName === previousRouteName) return;

      previousRouteName = routeName;
      await client.screen(routeName, includeRouteParams && route?.params ? { routeParams: route.params } : undefined, {
        pathname: asPathname(getPath(route)),
        screen: routeName,
      });
    };

    return {
      onReady: trackCurrentRoute,
      onStateChange: trackCurrentRoute,
      trackCurrentRoute,
    };
  }

  cleanup() {
    this.appStateSubscription?.remove?.();
    this.appStateSubscription = null;
    if (!this.replayConfigured) return Promise.resolve();
    this.replayControlVersion += 1;
    this.replayManuallyStopped = true;
    return this.enqueueLifecycleOperation(() => this.pauseSessionReplay());
  }

  ensureInitialized() {
    if (!this.config || !this.anonymousId) {
      throw new Error("rybbit.init() must be called before tracking");
    }
    if (typeof this.config.fetch !== "function") {
      throw new Error("No fetch implementation is available");
    }
  }

  debug(message, error) {
    if (this.config?.debug) {
      console.warn(`[Rybbit] ${message}`, error);
    }
  }
}

const defaultClient = new RybbitReactNative();

module.exports = defaultClient;
module.exports.default = defaultClient;
module.exports.RybbitReactNative = RybbitReactNative;
