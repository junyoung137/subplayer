// DEPLOYMENT NOTES:
// 1. Replace DEV_ANDROID_API_KEY and PROD_ANDROID_API_KEY with your real keys from RevenueCat dashboard
// 2. RevenueCat entitlement IDs must be exactly: realtimesub_lite, realtimesub_standard, realtimesub_pro
// 3. Google Play product identifiers must match exactly: realtimesub_lite, realtimesub_standard, realtimesub_pro
// 4. Expo Go will not work after this change — build with: npx expo run:android
// 5. Place <RestorePurchasesButton /> in your settings screen (required by Google Play policy)
// 6. FUTURE: When adding monthly/yearly variants, extend PRODUCT_ID_MAP values to string arrays
//    e.g. lite: ["realtimesub_lite_monthly", "realtimesub_lite_yearly"]
//    and update the offerings.find() logic in PricingScreen accordingly.

// Dev key: used in __DEV__ mode (Expo development build)
// Prod key: used in release builds
const DEV_ANDROID_API_KEY  = "test_zKfpsIjPLZWazCisZTCEqTvJRTk";
const PROD_ANDROID_API_KEY = "rc_YOUR_PROD_KEY_HERE";

export const REVENUECAT_ANDROID_API_KEY: string =
  __DEV__ ? DEV_ANDROID_API_KEY : PROD_ANDROID_API_KEY;

// Offerings TTL: re-fetch offerings if cached longer than this (milliseconds)
export const OFFERINGS_TTL_MS = 60 * 60 * 1000; // 1 hour

// Single product identifier per plan tier (MVP: one product per plan)
export const PRODUCT_ID_MAP: Record<"lite" | "standard" | "pro", string> = {
  lite:     "realtimesub_lite",
  standard: "realtimesub_standard",
  pro:      "realtimesub_pro",
};

// RevenueCat entitlement identifiers
export const ENTITLEMENT_MAP: Record<string, "lite" | "standard" | "pro"> = {
  realtimesub_lite:     "lite",
  realtimesub_standard: "standard",
  realtimesub_pro:      "pro",
};

// Explicit priority: first match wins (pro > standard > lite)
export const ENTITLEMENT_PRIORITY = [
  "realtimesub_pro",
  "realtimesub_standard",
  "realtimesub_lite",
] as const;

/**
 * Call this once at app startup (before configure) to catch missing keys early.
 * Warns in development if dev key is placeholder.
 * Throws in production if prod key is placeholder — never ships with missing key.
 */
export function validateRevenueCatKey(): void {
  const key = REVENUECAT_ANDROID_API_KEY;
  const isPlaceholder = key.includes("YOUR") || key.trim() === "";

  if (__DEV__) {
    if (isPlaceholder) {
      console.warn(
        "[RevenueCat] DEV key is not set. " +
        "Purchases will not work. Set DEV_ANDROID_API_KEY in revenueCatConfig.ts"
      );
    }
  } else {
    if (isPlaceholder) {
      throw new Error(
        "[RevenueCat] PROD key is not set. " +
        "Set PROD_ANDROID_API_KEY in revenueCatConfig.ts before releasing."
      );
    }
  }
}
