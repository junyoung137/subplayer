import { useCallback } from "react";

/**
 * Stub — translation is being migrated from MyMemory to on-device llama.rn.
 * Re-translation is temporarily disabled until the new service is wired up.
 */
export function useRetranslate() {
  const retranslate = useCallback(async (_newTargetLang: string) => {
    console.log("[useRetranslate] Translation service not yet available.");
  }, []);

  const cancelRetranslation = useCallback(() => {}, []);

  return { isRetranslating: false, retranslate, cancelRetranslation };
}
