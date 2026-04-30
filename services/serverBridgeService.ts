/**
 * serverBridgeService.ts
 * RunPod serverless GPU API for Standard/Pro plans. Never called for Free.
 *
 * BILLING INVARIANTS:
 * - ALL billing → safeRecordUsage() — direct recordUsage() BANNED (RULE 10)
 * - Billing BEFORE persist — dedup guards double-billing on persist fail
 * - usageSeconds missing → throw immediately, never estimate (RULE 2)
 * - serverTranscribe usageSeconds intentionally NOT billed
 *
 * FALLBACK (RULE 6):
 * - UNKNOWN → retry ONCE with SAME jobKey (RULE 13) → still UNKNOWN → Gemma fallback
 *   (no billing + no GPU recompute — server honors idempotency key)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ── [DEV MODE] Dynamic imports — no-ops / tree-shaken in production ───────────
let _DevConfig: typeof import('../utils/devConfig').DevConfig | null = null;
let _DevLogger: typeof import('../utils/devLogger').DevLogger | null = null;
if (__DEV__) {
  import('../utils/devConfig').then(m => { _DevConfig = m.DevConfig; }).catch(() => {});
  import('../utils/devLogger').then(m => { _DevLogger = m.DevLogger; }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ServerTranscribeRequest {
  audioBase64: string;
  sourceLanguage: string;
  chunkStartSec: number;
}

export interface ServerTranscribeResponse {
  segments: Array<{ start: number; end: number; text: string }>;
  language: string;
  usageSeconds: number;
}

export interface ServerTranslateRequest {
  segments: Array<{ start: number; end: number; text: string }>;
  targetLanguage: string;
  videoId: string; // deterministic jobKey — server idempotency key
}

export interface ServerTranslateResponse {
  segments: Array<{ start: number; end: number; text: string; translated: string }>;
  usageSeconds: number;  // BILLING SOURCE OF TRUTH
  completed: boolean;
}

export interface ServerCompletedBatch {
  batchIndex: number;
  segments: Array<{ start: number; end: number; text: string; translated: string }>;
  usageSeconds: number;
}

export type CompletedBatchesState = 'COMPLETED' | 'NOT_COMPLETED' | 'UNKNOWN';

export interface ServerCompletedBatchesResponse {
  state: CompletedBatchesState;
  completedBatchIndices: number[];
  batches: ServerCompletedBatch[];
}

export interface ServerBridgeConfig {
  runpodEndpointBase: string;
  apiKey: string;
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// RULE 11: Server error classification
// ─────────────────────────────────────────────────────────────────────────────

export type ServerErrorClass = 'retryable' | 'auth' | 'validation' | 'unknown';

export function classifyServerError(err: any): ServerErrorClass {
  const status = err?.status ?? err?.statusCode ?? 0;
  const msg = (err?.message ?? '').toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 422) return 'validation';
  if (
    status >= 500 ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound')
  ) return 'retryable';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// RULE 12: Usage dedup — lazy-hydrated Map + disk
// ─────────────────────────────────────────────────────────────────────────────

const USAGE_DEDUP_KEY   = 'usage_dedup_v1';
const DEDUP_TTL_MS      = 72 * 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 5000;

export const _usageRecorded = new Map<string, number>();

let _hydrated       = false;
let _hydratePromise: Promise<void> | null = null;

function pruneDedup(): void {
  const now = Date.now();
  // Step 1: TTL prune (MUST run first — billing safety)
  for (const [key, ts] of _usageRecorded) {
    if (now - ts > DEDUP_TTL_MS) _usageRecorded.delete(key);
  }
  // Step 2: LRU cap (only after TTL prune)
  if (_usageRecorded.size > DEDUP_MAX_ENTRIES) {
    const removeCount = _usageRecorded.size - DEDUP_MAX_ENTRIES;
    let removed = 0;
    for (const key of _usageRecorded.keys()) {
      if (removed >= removeCount) break;
      _usageRecorded.delete(key);
      removed++;
    }
  }
}

function registerJobKey(jobKey: string): void {
  if (_usageRecorded.has(jobKey)) return;
  _usageRecorded.set(jobKey, Date.now());
  pruneDedup();
}

export async function hydrateUsageDedup(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(USAGE_DEDUP_KEY);
    if (raw) {
      const persisted: Record<string, number> = JSON.parse(raw);
      const now = Date.now();
      for (const [key, ts] of Object.entries(persisted)) {
        if (now - ts < DEDUP_TTL_MS && !_usageRecorded.has(key)) {
          _usageRecorded.set(key, ts); // original ts preserved (RULE 12)
        }
      }
      pruneDedup();
    }
    console.log(`[UsageDedup] Hydrated: ${_usageRecorded.size} entries`);
  } catch (e) {
    console.warn('[UsageDedup] Hydrate failed (non-fatal):', e);
  } finally {
    _hydrated = true;
  }
}

async function _persistDedupAsync(): Promise<void> {
  const snapshot: Record<string, number> = {};
  const now = Date.now();
  for (const [k, ts] of _usageRecorded) {
    if (now - ts < DEDUP_TTL_MS) snapshot[k] = ts;
  }
  await AsyncStorage.setItem(USAGE_DEDUP_KEY, JSON.stringify(snapshot));
}

/**
 * safeRecordUsage — single billing entry point (RULE 10 + 12)
 *
 * Execution order:
 * 0. Hydration race guard: join _hydratePromise if in-progress; start new only if neither done nor started
 * 1. Memory check (sync fast path)
 * 2. Disk check (async) → restore original ts on hit
 * 3. Race-check: has() re-verify after await gap
 * 4. registerJobKey (memory write)
 * 5. BILLING ← BEFORE persist
 * 6. Persist (fire-and-forget) — persist fail → log only, no rollback
 */
export async function safeRecordUsage(
  jobKey: string,
  usageSeconds: number,
  recordUsageFn: (seconds: number) => void,
  recordGpuSecondsFn: (seconds: number, tier: string) => Promise<void>,
  tier: string,
): Promise<boolean> {

  // [DEV 3c] Skip billing in dev mode — return true so pipeline continues normally
  if (__DEV__ && _DevConfig?.isDevMode()) {
    _DevLogger?.log('billing_skipped',
      `BILLING SKIPPED (dev mode) — ${jobKey} · ${usageSeconds}s · tier=${tier}`,
    );
    console.log(`[UsageDedup] DEV — billing skipped: ${jobKey} (${usageSeconds}s)`);
    return true;  // true = "recorded" — pipeline proceeds; no real charge
  }

  // Step 0: hydration race guard
  if (!_hydrated) {
    if (_hydratePromise) {
      await _hydratePromise;
    } else {
      _hydratePromise = hydrateUsageDedup();
      await _hydratePromise;
    }
  }

  // Step 1: memory check
  if (_usageRecorded.has(jobKey)) {
    console.log(`[UsageDedup] Skipped (memory): ${jobKey}`);
    return false;
  }

  // Step 2: disk check
  let diskTs: number | undefined;
  try {
    const raw = await AsyncStorage.getItem(USAGE_DEDUP_KEY);
    if (raw) {
      const persisted: Record<string, number> = JSON.parse(raw);
      const ts = persisted[jobKey];
      if (ts !== undefined && Date.now() - ts < DEDUP_TTL_MS) diskTs = ts;
    }
  } catch { /* treat as miss */ }

  if (diskTs !== undefined) {
    if (!_usageRecorded.has(jobKey)) _usageRecorded.set(jobKey, diskTs);
    console.log(`[UsageDedup] Skipped (disk): ${jobKey}`);
    return false;
  }

  // Step 3: race-check
  if (_usageRecorded.has(jobKey)) {
    console.log(`[UsageDedup] Skipped (race): ${jobKey}`);
    return false;
  }

  // Step 4: register
  registerJobKey(jobKey);

  // Step 5: BILLING — before persist
  recordUsageFn(usageSeconds);
  recordGpuSecondsFn(usageSeconds, tier).catch(() => {});
  console.log(`[UsageDedup] Billed: ${jobKey} (${usageSeconds}s)`);

  // Step 6: persist (fire-and-forget)
  _persistDedupAsync().catch(e => {
    console.warn('[UsageDedup] Persist failed (billing already done):', e);
  });

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_KEY          = 'server_bridge_config';
const DEFAULT_TIMEOUT_MS  = 120_000;
const MAX_RETRIES         = 3;
const RETRY_DELAY_BASE_MS = 1000;

let _config: ServerBridgeConfig | null = null;

export async function initServerBridge(config: ServerBridgeConfig): Promise<void> {
  _config = config;
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export async function loadServerBridgeConfig(): Promise<ServerBridgeConfig | null> {
  if (!_config) {
    try {
      const raw = await AsyncStorage.getItem(CONFIG_KEY);
      if (raw) _config = JSON.parse(raw) as ServerBridgeConfig;
    } catch {}
  }
  // [DEV 3b] Inject endpoint/apiKey overrides when dev mode is active
  if (__DEV__ && _DevConfig?.isDevMode()) {
    const dev = _DevConfig.getState();
    if (dev.endpointOverride || dev.apiKeyOverride) {
      const base = _config ?? { runpodEndpointBase: '', apiKey: '' };
      return {
        ...base,
        runpodEndpointBase: dev.endpointOverride ?? base.runpodEndpointBase,
        apiKey: dev.apiKeyOverride ?? base.apiKey,
      };
    }
  }
  return _config;
}

export function clearServerBridgeConfig(): void {
  _config = null;
  AsyncStorage.removeItem(CONFIG_KEY).catch(() => {});
}

export function isServerBridgeConfigured(): boolean {
  return _config !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency limiter (FIFO)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_INFLIGHT = 2;
let _inflightCount = 0;
const _waitQueue: Array<() => void> = [];

async function waitForSlot(): Promise<void> {
  if (_inflightCount < MAX_INFLIGHT) { _inflightCount++; return; }
  await new Promise<void>(resolve => _waitQueue.push(resolve));
  _inflightCount++;
}

function releaseSlot(): void {
  _inflightCount = Math.max(0, _inflightCount - 1);
  const next = _waitQueue.shift();
  if (next) next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate job protection (RULE 5)
// ─────────────────────────────────────────────────────────────────────────────

const _activeJobs = new Map<string, Promise<ServerTranslateResponse>>();

// ─────────────────────────────────────────────────────────────────────────────
// AbortController pool (RULE 7)
// ─────────────────────────────────────────────────────────────────────────────

const _activeControllers = new Set<AbortController>();

export function cancelAllInflight(): void {
  for (const ctrl of _activeControllers) {
    try { ctrl.abort(); } catch {}
  }
  _activeControllers.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchWithRetry
// ─────────────────────────────────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  options: Omit<RequestInit, 'signal'>,
  timeoutMs: number,
  retries = MAX_RETRIES,
): Promise<Response> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    _activeControllers.add(controller);
    const effectiveTimeout = attempt <= 1 ? Math.max(timeoutMs, 30_000) : timeoutMs;
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    // [DEV 3d] Log request_start (3-arg: level, message, opts?)
    const _t0 = __DEV__ ? Date.now() : 0;
    if (__DEV__) {
      _DevLogger?.log('request_start',
        `→ ${(options.method ?? 'GET')} ${url.split('/').pop() ?? url} (attempt ${attempt + 1})`,
        { detail: url, attempt },
      );
    }

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      _activeControllers.delete(controller);
      // [DEV 3d] Log success/failure
      if (__DEV__) {
        if (response.ok) {
          _DevLogger?.log('request_success',
            `✓ ${response.status} ${url.split('/').pop() ?? url}`,
            { detail: url.split('/').pop() ?? url, durationMs: Date.now() - _t0 },
          );
        } else {
          _DevLogger?.log('request_error',
            `✗ ${response.status} ${url.split('/').pop() ?? url}`,
            { detail: url.split('/').pop() ?? url, durationMs: Date.now() - _t0 },
          );
        }
      }
      if (response.ok) return response;

      const errClass = classifyServerError({ status: response.status });
      const text = await response.text().catch(() => '');

      if (errClass === 'auth' || errClass === 'validation') {
        const fatalErr = new Error(`Server returned ${response.status}: ${text}`);
        (fatalErr as any).status = response.status;
        throw fatalErr;
      }

      lastError = new Error(`Server error ${response.status}: ${text}`);
      (lastError as any).status = response.status;
    } catch (e: any) {
      clearTimeout(timer);
      _activeControllers.delete(controller);
      if (__DEV__) {
        _DevLogger?.log('request_error',
          `✗ ${e?.name === 'AbortError' ? 'timeout' : (e?.message ?? 'error')} ${url.split('/').pop() ?? url}`,
          { detail: url.split('/').pop() ?? url, durationMs: Date.now() - _t0 },
        );
      }
      if (e?.status === 401 || e?.status === 403 || e?.status === 400 || e?.status === 422) {
        throw e;
      }
      if (e?.name === 'AbortError') {
        lastError = new Error(`Request timed out after ${effectiveTimeout}ms`);
      } else {
        lastError = e;
      }
    }

    if (attempt < retries) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_BASE_MS * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchCompletedBatches — 3-state result (RULE 4 + RULE 6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns 3-state result:
 *   COMPLETED    → server has results → use them + bill
 *   NOT_COMPLETED → not completed → Gemma fallback allowed
 *   UNKNOWN      → server error → caller retries ONCE with SAME jobKey (RULE 13),
 *                  then Gemma fallback (no billing, no GPU recompute)
 * Never throws.
 */
export async function fetchCompletedBatches(
  stableVideoId: string,
): Promise<ServerCompletedBatchesResponse> {
  const config = await loadServerBridgeConfig();
  if (!config) {
    return { state: 'UNKNOWN', completedBatchIndices: [], batches: [] };
  }

  try {
    const url = `${config.runpodEndpointBase.replace(/\/$/, '')}/checkpoints/${encodeURIComponent(stableVideoId)}`;
    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
    }, 15_000, 1);

    const data = await response.json();
    const indices: number[] = data.completedBatchIndices ?? [];
    const batches: ServerCompletedBatch[] = data.batches ?? [];

    return {
      state: indices.length > 0 ? 'COMPLETED' : 'NOT_COMPLETED',
      completedBatchIndices: indices,
      batches,
    };
  } catch (e) {
    console.warn('[ServerBridge] fetchCompletedBatches error — state: UNKNOWN:', e);
    return { state: 'UNKNOWN', completedBatchIndices: [], batches: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// serverTranscribe
// ─────────────────────────────────────────────────────────────────────────────

export async function serverTranscribe(
  request: ServerTranscribeRequest,
): Promise<ServerTranscribeResponse> {
  const config = await loadServerBridgeConfig();
  if (!config) throw new Error('[ServerBridge] Not configured.');

  await waitForSlot();
  try {
    const url = `${config.runpodEndpointBase.replace(/\/$/, '')}/transcribe`;
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
      body: JSON.stringify(request),
    }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const data = await response.json();
    if (!data.segments || !Array.isArray(data.segments)) {
      throw new Error('[ServerBridge] Invalid transcribe response: missing segments');
    }
    // Transcribe usageSeconds: informational only, NOT billed (RULE 2). Estimate if missing.
    if (typeof data.usageSeconds !== 'number') {
      const span = data.segments.length > 0
        ? (data.segments[data.segments.length - 1].end - data.segments[0].start)
        : 30;
      data.usageSeconds = Math.ceil(span);
    }
    return data as ServerTranscribeResponse;
  } finally {
    releaseSlot();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// serverTranslate (RULE 5: dedup by jobKey)
// ─────────────────────────────────────────────────────────────────────────────

export async function serverTranslate(
  request: ServerTranslateRequest,
): Promise<ServerTranslateResponse> {
  const existing = _activeJobs.get(request.videoId);
  if (existing) {
    console.log(`[ServerBridge] Dedup: returning existing job for ${request.videoId}`);
    return existing;
  }
  const job = _serverTranslateImpl(request);
  _activeJobs.set(request.videoId, job);
  try {
    return await job;
  } finally {
    _activeJobs.delete(request.videoId);
  }
}

async function _serverTranslateImpl(
  request: ServerTranslateRequest,
): Promise<ServerTranslateResponse> {
  const config = await loadServerBridgeConfig();
  if (!config) throw new Error('[ServerBridge] Not configured.');

  await waitForSlot();
  try {
    const url = `${config.runpodEndpointBase.replace(/\/$/, '')}/translate`;
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
      body: JSON.stringify(request),
    }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const data = await response.json();
    if (!data.segments || !Array.isArray(data.segments)) {
      throw new Error('[ServerBridge] Invalid translate response: missing segments');
    }
    // STRICT: usageSeconds must be present — no estimation allowed (RULE 2)
    if (typeof data.usageSeconds !== 'number') {
      throw new Error(
        '[ServerBridge] Missing usageSeconds in server response — billing contract violation.'
      );
    }
    if (typeof data.completed !== 'boolean') data.completed = true;
    return data as ServerTranslateResponse;
  } finally {
    releaseSlot();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

export function makeStableVideoId(videoUri: string): string {
  try {
    const decoded = decodeURIComponent(videoUri);
    const withoutFragment = decoded.split('#')[0];
    const parts = withoutFragment.replace(/\\/g, '/').split('/');
    const filename = parts[parts.length - 1] ?? videoUri;
    return filename.split('?')[0];
  } catch {
    return videoUri;
  }
}

/**
 * makeDeterministicYtKey
 * Stable jobKey — never Date.now(). Same segments → same key → server idempotency.
 * RULE 13: On UNKNOWN retry, pass the already-computed key. Do NOT call this again.
 */
export function makeDeterministicYtKey(
  stableId: string,
  segments: Array<{ start: number; end: number }>,
): string {
  if (segments.length === 0) return `${stableId}_yt_empty`;
  const first = Math.round(segments[0].start * 1000);
  const last  = Math.round(segments[segments.length - 1].end * 1000);
  return `${stableId}_yt_${segments.length}_${first}_${last}`;
}
