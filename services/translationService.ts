/**
 * Network-based translation service with a prioritised failover queue.
 *
 * Priority order:
 *   1. lingva.ml           (public Lingva instance)
 *   2. lingva.lunar        (Lingva – lunar.icu mirror)
 *   3. lingva.plausibility (Lingva – plausibility.cloud mirror)
 *   4. mymemory            (MyMemory free API – no key required)
 *
 * On failure or invalid output, an API is temporarily blocked with
 * exponential back-off before retrying.  The next available API is tried
 * immediately (no delay) so the caller sees minimal latency.
 */

// ── Per-API call functions ────────────────────────────────────────────────────

async function callLingva(
  baseUrl: string,
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string | null> {
  const encoded = encodeURIComponent(text);
  const src     = sourceLang === "auto" ? "auto" : sourceLang;
  const url     = `${baseUrl}/api/v1/${src}/${targetLang}/${encoded}`;

  const response = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const json = await response.json();
  return (json?.translation as string) ?? null;
}

async function callLingvaML(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string | null> {
  return callLingva("https://lingva.ml", text, sourceLang, targetLang);
}

async function callLingvaLunar(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string | null> {
  return callLingva("https://lingva.lunar.icu", text, sourceLang, targetLang);
}

async function callLingvaPlausibility(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string | null> {
  return callLingva("https://translate.plausibility.cloud", text, sourceLang, targetLang);
}

async function callMyMemory(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string | null> {
  const src = sourceLang === "auto" ? "en" : sourceLang;
  const url =
    `https://api.mymemory.translated.net/get` +
    `?q=${encodeURIComponent(text)}&langpair=${src}|${targetLang}`;

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const json = await response.json();
  const result = json?.responseData?.translatedText as string;
  // MyMemory returns the original text unchanged when the pair is unsupported
  if (!result || result === text) return null;
  return result;
}

// ── API registry and status tracking ─────────────────────────────────────────

interface ApiEntry {
  name: string;
  fn: (text: string, src: string, tgt: string) => Promise<string | null>;
}

const TRANSLATION_APIS: ApiEntry[] = [
  { name: "lingva-ml",          fn: callLingvaML          },
  { name: "lingva-lunar",       fn: callLingvaLunar       },
  { name: "lingva-plausibility",fn: callLingvaPlausibility},
  { name: "mymemory",           fn: callMyMemory          },
];

interface ApiStatus {
  blocked: boolean;
  blockedUntil: number;
  failCount: number;
}

const apiStatus = new Map<string, ApiStatus>();

function isApiAvailable(name: string): boolean {
  const s = apiStatus.get(name);
  if (!s) return true;
  if (s.blocked && Date.now() >= s.blockedUntil) {
    // Cooldown expired — reset
    apiStatus.set(name, { blocked: false, blockedUntil: 0, failCount: 0 });
    return true;
  }
  return !s.blocked;
}

function markApiBlocked(name: string, baseDurationMs = 60_000): void {
  const current = apiStatus.get(name) ?? { blocked: false, blockedUntil: 0, failCount: 0 };
  const failCount = current.failCount + 1;
  // Exponential back-off capped at 10 min: 1m → 2m → 4m → … → 10m
  const backoffMs = Math.min(baseDurationMs * Math.pow(2, failCount - 1), 10 * 60_000);
  console.log(`[Translation] ${name} blocked for ${Math.round(backoffMs / 1000)}s (fail #${failCount})`);
  apiStatus.set(name, { blocked: true, blockedUntil: Date.now() + backoffMs, failCount });
}

function markApiSuccess(name: string): void {
  apiStatus.set(name, { blocked: false, blockedUntil: 0, failCount: 0 });
}

// ── Translation validation ────────────────────────────────────────────────────

/**
 * Verify that `translated` is a plausible translation of `original`.
 * For non-Latin scripts the presence of at least one expected character is
 * required.  For Latin-script targets any non-empty, non-identical result is
 * accepted.
 */
function isTranslationValid(
  original: string,
  translated: string,
  targetLang: string,
): boolean {
  if (!translated?.trim()) return false;
  if (translated.trim() === original.trim()) return false;

  const scriptPatterns: Record<string, RegExp> = {
    ko: /[가-힣]/,
    ja: /[\u3040-\u30FF\u4E00-\u9FAF]/,
    zh: /[\u4E00-\u9FAF]/,
    ar: /[\u0600-\u06FF]/,
    ru: /[\u0400-\u04FF]/,
    th: /[\u0E00-\u0E7F]/,
  };

  const pattern = scriptPatterns[targetLang];
  if (pattern) return pattern.test(translated);

  // Latin-script languages: any non-identical, non-empty result is valid
  return true;
}

// ── Fragment detection ────────────────────────────────────────────────────────

/**
 * Returns true for segments that are grammatical fragments unlikely to
 * produce a useful standalone translation (e.g. "of age story.",
 * "and the rest.").  Callers may choose to append these to the previous
 * segment's translation rather than translating in isolation.
 */
export function isFragmentOnly(text: string): boolean {
  const trimmed = text.trim();
  // Starts with a lowercase fragment connector or article
  if (/^(of|and|but|or|so|yet|for|nor|the|a|an)\b/i.test(trimmed)) return true;
  // 1–2 words, does not start with a capital letter
  if (trimmed.split(/\s+/).length <= 2 && !/^[A-Z]/.test(trimmed)) return true;
  return false;
}

// ── Last-resort fallback ──────────────────────────────────────────────────────

/**
 * One final attempt using MyMemory with an explicit instruction prefix, used
 * when every other API in the queue has returned the original text unchanged.
 * A dedicated email parameter is included to qualify for MyMemory's higher
 * free-tier limit.
 */
async function lastResortTranslate(
  text: string,
  targetLang: string,
): Promise<string> {
  // Send an explicit instruction prefix so the API treats the text as a
  // translation task even for very short or grammatically unusual inputs.
  const withInstruction = `Translate to ${targetLang}: ${text}`;

  try {
    const encoded = encodeURIComponent(text);
    const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|${targetLang}&de=app@realtimesub.com`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = await response.json();
      const result = data?.responseData?.translatedText as string;
      if (result && isTranslationValid(text, result, targetLang)) {
        console.log(`[Translation] last-resort succeeded: "${text}" → "${result}"`);
        return result;
      }
    }
  } catch {}

  // Second attempt using the full instruction string
  try {
    const encoded = encodeURIComponent(withInstruction);
    const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|${targetLang}&de=app@realtimesub.com`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = await response.json();
      const result = data?.responseData?.translatedText as string;
      if (result && isTranslationValid(text, result, targetLang)) {
        console.log(`[Translation] last-resort (with instruction) succeeded: "${text}" → "${result}"`);
        return result;
      }
    }
  } catch {}

  return text;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Translate `text` from `sourceLang` to `targetLang` using the prioritised
 * API queue.  Fails over to the next available API immediately on error or
 * invalid response.  If every API fails, tries one last-resort MyMemory call.
 * Returns the original text only when all options are exhausted.
 */
export async function translateText(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string> {
  if (!text?.trim()) return text;
  if (sourceLang === targetLang) return text;

  const available = TRANSLATION_APIS.filter((api) => isApiAvailable(api.name));

  if (available.length === 0) {
    console.warn("[Translation] All APIs currently blocked — trying last resort");
    return lastResortTranslate(text, targetLang);
  }

  for (const api of available) {
    try {
      const result = await Promise.race<string | null>([
        api.fn(text, sourceLang, targetLang),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 8_000)
        ),
      ]);

      if (result && isTranslationValid(text, result, targetLang)) {
        markApiSuccess(api.name);
        return result;
      }

      // Responded but result is invalid → possible rate-limit or bad pair
      markApiBlocked(api.name, 30_000);
      continue;
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? "";
      const isRateLimit =
        msg.includes("429") || msg.includes("quota") || msg.includes("limit");
      markApiBlocked(api.name, isRateLimit ? 60_000 : 15_000);
      continue;
    }
  }

  console.warn(`[Translation] All APIs failed for: "${text.substring(0, 50)}" — trying last resort`);
  return lastResortTranslate(text, targetLang);
}

/**
 * Convenience wrapper: translates an array of texts with a shared source/target
 * language.  Runs calls sequentially with a 300 ms gap between requests to
 * avoid hitting free-tier rate limits on consecutive short phrases.
 */
export async function translateBatch(
  texts: string[],
  sourceLang: string,
  targetLang: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const results: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    results.push(await translateText(texts[i], sourceLang, targetLang));
    onProgress?.(i + 1, texts.length);
    // 300 ms pause between requests to avoid rate-limiting on free APIs
    if (i < texts.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    }
  }
  return results;
}

/**
 * Reset all API status entries (e.g. on app resume or network reconnection).
 */
export function resetApiStatus(): void {
  apiStatus.clear();
}
