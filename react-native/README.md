# @rybbit/react-native

React Native analytics and native session replay SDK for Rybbit.

## Install

```sh
npm install @rybbit/react-native @react-native-async-storage/async-storage
npx pod-install # iOS
```

Native replay is provided by the SDK's pinned direct dependency on `@posthog/react-native-plugin@2.12.0`. Rebuild the native app after installing. **Expo Go is not supported** because it cannot load custom native modules; use an Expo development build or a native React Native build. Analytics continues to work in Expo Go, while replay stays disabled and replay control calls report the unsupported environment.

## Usage

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import rybbit from "@rybbit/react-native";

await rybbit.init({
  analyticsHost: "https://app.rybbit.io/api",
  siteId: "your-site-id",
  appIdentifier: "com.example.app",
  storage: AsyncStorage,
  initialScreenName: "Home",

  // Native replay (also requires Session Replay enabled for the site)
  sessionReplaySampleRate: 1, // 0..1; 1 records every eligible session
  sessionReplayMaskAllTextInputs: true,
  sessionReplayMaskAllImages: true,
  sessionReplayMaskAllSandboxedViews: true,
  sessionReplayCaptureTouches: false,
  sessionReplayThrottleDelayMs: 1000,
});

await rybbit.event("signup_started", { plan: "pro" });
await rybbit.identify("user_123", { plan: "pro" });

await rybbit.stopSessionReplay(); // pause before a sensitive flow
await rybbit.startSessionReplay(); // resume the current replay session
const recording = await rybbit.isSessionReplayActive();
```

Replay defaults to the strongest privacy controls exposed by the pinned native plugin: text **inputs**, images, and sandboxed views are masked; touches, logs, and network telemetry are disabled. The plugin does **not** expose a setting that masks every visible text label. Do not treat `sessionReplayMaskAllTextInputs` as full-screen text masking. If a screen can show customer, employee, payroll, location, or other sensitive text outside an input, stop replay before displaying it.

Replay uses a persisted UUID session ID and adds the same ID to Rybbit analytics payloads. Backgrounding stops and closes the native recording. Foregrounding within 30 minutes resumes it; after the timeout, the SDK creates a new replay session. Configure the timeout with `sessionReplaySessionTimeoutMs`. An explicit `stopSessionReplay()` remains in effect across background/foreground transitions until `startSessionReplay()` is called.

## React Navigation

```tsx
const navigationTracker = rybbit.createNavigationTracker();

<NavigationContainer
  ref={navigationRef}
  onReady={() => navigationTracker.onReady(navigationRef.current)}
  onStateChange={() => navigationTracker.onStateChange(navigationRef.current)}
>
  {/* screens */}
</NavigationContainer>;
```

The SDK uses a generated anonymous install ID stored through the provided storage adapter. Pass AsyncStorage or a compatible storage object for persistence across app launches. Identity changes and resets are synchronized with native replay.
