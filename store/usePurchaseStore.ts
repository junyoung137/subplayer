import { create } from "zustand";
import Purchases, {
  PurchasesPackage,
  CustomerInfo,
  PURCHASES_ERROR_CODE,
} from "react-native-purchases";
import type { PurchasesError } from "react-native-purchases";

function isPurchasesError(e: unknown): e is PurchasesError {
  return typeof e === "object" && e !== null && "code" in e;
}
import { useSettingsStore } from "./useSettingsStore";
import {
  ENTITLEMENT_MAP,
  ENTITLEMENT_PRIORITY,
  OFFERINGS_TTL_MS,
  validateRevenueCatKey,
} from "../utils/revenueCatConfig";
import type { PlanTier } from "./usePlanStore";

interface PurchaseStore {
  isConfigured: boolean;
  offerings: PurchasesPackage[];
  offeringsFetchedAt: number | null;
  customerInfo: CustomerInfo | null;
  isLoading: boolean;
  error: string | null;
  configure: (apiKey: string) => Promise<void>;
  fetchOfferings: (force?: boolean) => Promise<void>;
  purchasePackage: (pkg: PurchasesPackage) => Promise<void>;
  restorePurchases: () => Promise<void>;
  syncPlanFromCustomerInfo: (info: CustomerInfo) => void;
  clearError: () => void;
}

// Module-level flag to prevent duplicate listener registration across hot reloads
let _listenerRegistered = false;

let _configureResolve: (() => void) | null = null;
let _configurePromise: Promise<void> = new Promise<void>((resolve) => {
  _configureResolve = resolve;
});

export const usePurchaseStore = create<PurchaseStore>((set, get) => ({
  isConfigured: false,
  offerings: [],
  offeringsFetchedAt: null,
  customerInfo: null,
  isLoading: false,
  error: null,

  configure: async (apiKey: string) => {
    console.log('[RevenueCat] configure() START');
    try {
      // Validate key before anything else — warns in dev, throws in prod for placeholders
      validateRevenueCatKey();
      console.log('[RevenueCat] Step 1: validateRevenueCatKey passed');

      console.log('[RevenueCat] Step 2: calling Purchases.configure()');

      Purchases.configure({ apiKey });
      console.log('[RevenueCat] Step 3: Purchases.configure() called');

      // Register background subscription update listener exactly once
      if (!_listenerRegistered) {
        _listenerRegistered = true;
        Purchases.addCustomerInfoUpdateListener((info) => {
          usePurchaseStore.getState().syncPlanFromCustomerInfo(info);
        });
      }

      // Wait for native singleton to be fully registered before any Purchases calls.
      // Purchases.configure() is synchronous at JS level but the native module
      // needs a tick to register the singleton — immediate calls throw
      // "There is no singleton instance".
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      console.log('[RevenueCat] Step 4: 300ms wait done');

      // Fetch offerings before marking configured — prevents PricingScreen
      // subscription from triggering a concurrent fetchOfferings during this window.
      const { offeringsFetchedAt } = usePurchaseStore.getState();
      try {
        const result = await Purchases.getOfferings();
        const packages = result.current?.availablePackages ?? [];
        console.log('[RevenueCat] fetchOfferings inside configure: packages count:', packages.length);
        usePurchaseStore.setState({ offerings: packages, offeringsFetchedAt: Date.now() });
      } catch (e) {
        console.error('[RevenueCat] fetchOfferings inside configure failed:', e instanceof Error ? e.message : String(e));
      }

      // Mark configured only after offerings fetch completes (or fails).
      // PricingScreen's Zustand subscription checks this flag.
      set({ isConfigured: true });
      console.log('[RevenueCat] configure() COMPLETE');
      _configureResolve?.();
    } catch (e) {
      console.error('[RevenueCat] configure() THREW:', e instanceof Error ? e.message : String(e));
    }
  },

  fetchOfferings: async (force = false) => {
    if (!get().isConfigured) {
      const timeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5000)
      );
      try {
        await Promise.race([_configurePromise, timeout]);
      } catch {
        console.warn('[RevenueCat] fetchOfferings() timed out waiting for configure()');
        return;
      }
    }

    const { offeringsFetchedAt } = get();
    const now = Date.now();

    // Skip if cached within TTL, unless forced
    if (
      !force &&
      offeringsFetchedAt !== null &&
      now - offeringsFetchedAt < OFFERINGS_TTL_MS
    ) {
      return;
    }

    try {
      const result = await Purchases.getOfferings();
      const packages = result.current?.availablePackages ?? [];
      set({ offerings: packages, offeringsFetchedAt: now });
    } catch (e) {
      console.error("[RevenueCat] fetchOfferings error:", {
        message: e instanceof Error ? e.message : String(e),
      });
      set({ error: e instanceof Error ? e.message : "Failed to fetch offerings" });
    }
  },

  purchasePackage: async (pkg: PurchasesPackage) => {
    // isLoading guard lives here as the authoritative lock
    // PricingScreen's purchasingRef is an additional UI-layer guard only
    if (get().isLoading) return;
    set({ isLoading: true, error: null });

    try {
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      get().syncPlanFromCustomerInfo(customerInfo);
      set({ customerInfo });
    } catch (e) {
      // Use typed error code for cross-platform cancellation detection
      const isCancelled =
        isPurchasesError(e) &&
        e.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR;

      if (!isCancelled) {
        // Structured log — payment errors are hard to trace without detail
        console.error("[RevenueCat] purchasePackage error:", {
          code: isPurchasesError(e) ? e.code : "unknown",
          message: e instanceof Error ? e.message : String(e),
          productId: pkg.product.identifier,
        });
        set({ error: e instanceof Error ? e.message : "Purchase failed" });
      }
    } finally {
      // isLoading: false here is what unlocks purchasingRef in PricingScreen
      set({ isLoading: false });
    }
  },

  restorePurchases: async () => {
    if (get().isLoading) return;
    set({ isLoading: true, error: null });

    try {
      const customerInfo = await Purchases.restorePurchases();
      const hasActive = Object.keys(customerInfo.entitlements.active).length > 0;

      if (hasActive) {
        get().syncPlanFromCustomerInfo(customerInfo);
        set({ customerInfo });
      } else {
        // Distinguish "nothing to restore" from actual errors
        set({ error: "NO_ACTIVE_PURCHASES" });
      }
    } catch (e) {
      console.error("[RevenueCat] restorePurchases error:", {
        message: e instanceof Error ? e.message : String(e),
      });
      set({ error: e instanceof Error ? e.message : "Restore failed" });
    } finally {
      set({ isLoading: false });
    }
  },

  syncPlanFromCustomerInfo: (info: CustomerInfo) => {
    const active = info.entitlements.active;
    let resolvedTier: PlanTier = "free";
    let expiryMs: number | null = null;

    // Iterate in explicit priority: pro > standard > lite
    for (const entitlementId of ENTITLEMENT_PRIORITY) {
      if (active[entitlementId]) {
        resolvedTier = ENTITLEMENT_MAP[entitlementId];
        const rawExpiry = active[entitlementId].expirationDate;
        // null = lifetime purchase (no expiry). usePlanStore treats null as never-expires.
        expiryMs = rawExpiry ? new Date(rawExpiry).getTime() : null;
        break;
      }
    }

    // Triggers existing usePlanStore subscriber automatically via useSettingsStore.subscribe()
    // Do NOT call usePlanStore directly
    useSettingsStore.getState().update({
      plan: resolvedTier,
      planExpiresAt: expiryMs,
    });

    if (__DEV__) {
      console.log("[RevenueCat] syncPlan →", resolvedTier, "expiryMs:", expiryMs);
    }
  },

  clearError: () => set({ error: null }),
}));

// Selector hooks
export const useOfferings = () => usePurchaseStore(s => s.offerings);
export const usePurchaseLoading = () => usePurchaseStore(s => s.isLoading);
export const usePurchaseError = () => usePurchaseStore(s => s.error);
