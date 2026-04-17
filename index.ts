// Global unhandled promise rejection handler — prevents silent crashes where a
// rejected promise with no .catch() would kill the process on Android.
// This must be registered before any async code runs.
const _origHandler = (global as any).onunhandledrejection;
(global as any).onunhandledrejection = (event: any) => {
  console.error('[GLOBAL] Unhandled promise rejection:', event?.reason ?? event);
  if (_origHandler) _origHandler(event);
};

import "expo-router/entry";
