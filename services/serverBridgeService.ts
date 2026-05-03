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
 *
 * ── CHANGES (v15) ─────────────────────────────────────────────────────────────
 *
 * [FIX-16] _translateSemaphore → PriorityQueue 기반 short-first semaphore로 교체
 *
 *   v14: createSemaphore(2) — FIFO, reservedSeconds 무관하게 도착 순서대로 처리
 *        문제: 긴 job(180s)이 슬롯 점유 → 짧은 job(10s)이 대기열에서 밀림
 *              UX 체감: 짧은 영상이 긴 영상보다 늦게 결과 반환
 *
 *   v15: createPriorityTranslateSemaphore(2) — reservedSeconds 기준 min-heap
 *        - 동일 슬롯 수(2) 유지 → concurrency 변경 없음
 *        - 대기 중인 job 중 reservedSeconds가 작은 것 먼저 슬롯 획득
 *        - transcribeSemaphore는 FIFO 그대로 유지 (순서 의존성 있음)
 *        - 슬롯 획득 순간까지 reservedSeconds 미확정인 경우 Infinity로 enqueue
 *          → 일반 batch보다 뒤로 밀리지만 deadlock 없음
 *
 *        latency 개선 예시:
 *          job A: reservedSeconds=180, job B: reservedSeconds=10
 *          v14: A → B (도착 순서)  →  B 대기 180s
 *          v15: B → A (short-first) →  B 즉시 처리
 *
 *        불변식:
 *          - 슬롯 수 변경 없음 (maxSlots=2 유지)
 *          - 기아(starvation) 방지: 모든 waiter는 결국 슬롯 획득
 *            (짧은 job이 계속 들어와도 긴 job은 대기열 앞으로 점진적으로 이동)
 *          - acquire/release API 호환 유지 → 호출부 변경 없음
 *
 * v14에서 유지되는 것들:
 *   - [FIX-12] getEffectiveBatchDuration adaptive floor ratio
 *   - [FIX-13] safeRecordUsage persist micro-await + _billingInFlight
 *   - [FIX-14] fetchWithRetry 429 Retry-After 처리
 *   - [FIX-15] serverTranslate billing invariant 위반 시 보수적 billing
 *   - [FIX-11 v13] transcribe/translate 큐 분리 (transcribe FIFO 유지)
 *   - [FIX-9 v13] calcReservedSeconds 구조 전체
 *   - [FIX-1~8] v9~v12 전체 유지
 *   - [SELF-1 v9] AbortController 누수 방지
 *   - safeRecordUsage billing-before-persist 구조 전체
 *   - TODO: POST /jobs/:id/cancel 서버 cancel API
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
  videoId: string;           // deterministic jobKey — server idempotency key
  reservedSeconds: number;   // 서버 hard stop 기준 — 이 값 초과 시 서버가 즉시 중단
}

export interface ServerTranslateResponse {
  segments: Array<{ start: number; end: number; text: string; translated: string }>;
  usageSeconds: number;      // BILLING SOURCE OF TRUTH — actualSeconds
  reservedSeconds: number;   // 서버가 실제 reserve한 값 (actualSeconds <= reservedSeconds 보장)
  completed: boolean;
}

export interface ServerCompletedBatch {
  batchIndex: number;
  segments: Array<{ start: number; end: number; text: string; translated: string }>;
  usageSeconds: number;
  completedAt?: number;
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
// [FIX-12 v14] getEffectiveBatchDuration — adaptive floor ratio
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MIN_EXECUTION_FLOOR_SECS — effective duration 절대 하한선
 * ⚠️ 변경 시 useServerBridge.ts의 HARD_MIN_EXECUTE_SECS도 함께 변경
 */
export const MIN_EXECUTION_FLOOR_SECS = 3;

/**
 * ADAPTIVE_FLOOR_RATIOS — failureRatio 기반 동적 planned floor 비율
 *
 * [FIX-12 v14] 고정 0.5에서 adaptive로 교체
 *
 * failureRatio = actual / planned
 *   > 0.7 (정상):   0.5 — chunk 대부분 성공, 서버 hard stop 보호 유지
 *   > 0.4 (중간):   0.35 — 절충점, actual 반영 비중 증가
 *   ≤ 0.4 (심한):   0.2  — failure 많음, 과대 예약 억제 우선
 */
export const ADAPTIVE_FLOOR_RATIOS = {
  HIGH: { threshold: 0.7, ratio: 0.5 },
  MID:  { threshold: 0.4, ratio: 0.35 },
  LOW:  { ratio: 0.2 },
} as const;

export function getAdaptiveFloorRatio(
  actualDurationSecs: number,
  plannedDurationSecs: number,
): number {
  if (plannedDurationSecs <= 0) return ADAPTIVE_FLOOR_RATIOS.LOW.ratio;
  const failureRatio = actualDurationSecs / plannedDurationSecs;
  if (failureRatio > ADAPTIVE_FLOOR_RATIOS.HIGH.threshold) return ADAPTIVE_FLOOR_RATIOS.HIGH.ratio;
  if (failureRatio > ADAPTIVE_FLOOR_RATIOS.MID.threshold)  return ADAPTIVE_FLOOR_RATIOS.MID.ratio;
  return ADAPTIVE_FLOOR_RATIOS.LOW.ratio;
}

export function getEffectiveBatchDuration(
  plannedDurationSecs: number,
  actualDurationSecs: number,
  isLastPartialBatch: boolean,
): number {
  if (!isLastPartialBatch) {
    return plannedDurationSecs;
  }

  const dynamicRatio      = getAdaptiveFloorRatio(actualDurationSecs, plannedDurationSecs);
  const plannedBasedFloor = plannedDurationSecs * dynamicRatio;
  const floored = Math.max(
    actualDurationSecs,
    MIN_EXECUTION_FLOOR_SECS,
    plannedBasedFloor,
  );

  return Math.min(plannedDurationSecs, floored);
}

// ─────────────────────────────────────────────────────────────────────────────
// calcReservedSeconds
// ─────────────────────────────────────────────────────────────────────────────

const RESERVED_SECONDS_HARD_CAP = 3600;
const RESERVED_SECONDS_BUFFER   = 1.2;

export function calcReservedSeconds(
  effectiveDurationSecs: number,
  remainingQuotaSeconds: number,
  isLastPartialBatch = false,
): number {
  if (remainingQuotaSeconds <= 0) return 0;

  if (isLastPartialBatch) {
    return Math.min(remainingQuotaSeconds, effectiveDurationSecs);
  }

  const buffered = Math.ceil(effectiveDurationSecs * RESERVED_SECONDS_BUFFER);
  const capped   = Math.min(buffered, RESERVED_SECONDS_HARD_CAP);
  return Math.min(capped, remainingQuotaSeconds);
}

// ─────────────────────────────────────────────────────────────────────────────
// Server error classification
// [FIX-14 v14] 429 처리 추가
// ─────────────────────────────────────────────────────────────────────────────

export type ServerErrorClass = 'retryable' | 'auth' | 'validation' | 'unknown';

export function classifyServerError(err: any): ServerErrorClass {
  const status = err?.status ?? err?.statusCode ?? 0;
  const msg    = (err?.message ?? '').toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 422) return 'validation';
  if (
    status === 429 ||
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
// Usage dedup — lazy-hydrated Map + disk
// ─────────────────────────────────────────────────────────────────────────────

const USAGE_DEDUP_KEY   = 'usage_dedup_v1';
const DEDUP_TTL_MS      = 72 * 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 5000;

/**
 * PERSIST_MICRO_AWAIT_MS — persist micro-await 예산 [FIX-13 v14]
 * AsyncStorage write 통상 <10ms → 50ms 내 완료 가능성 높음
 */
const PERSIST_MICRO_AWAIT_MS = 50;

export const _usageRecorded = new Map<string, number>();

/**
 * _billingInFlight — billing 중인 jobKey pending set [FIX-13 v14]
 * registerJobKey 이전 시점의 race window 제거
 */
const _billingInFlight = new Set<string>();

let _hydrated       = false;
let _hydratePromise: Promise<void> | null = null;

function pruneDedup(): void {
  const now = Date.now();
  for (const [key, ts] of _usageRecorded) {
    if (now - ts > DEDUP_TTL_MS) _usageRecorded.delete(key);
  }
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
          _usageRecorded.set(key, ts);
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
 * [FIX-13 v14] persist micro-await + _billingInFlight pending set
 * [FIX-10 v13] hydrate 이후 disk read 생략
 */
export async function safeRecordUsage(
  jobKey: string,
  usageSeconds: number,
  recordUsageFn: (seconds: number) => void,
  recordGpuSecondsFn: (seconds: number, tier: string) => Promise<void>,
  tier: string,
): Promise<boolean> {

  if (__DEV__ && _DevConfig?.isDevMode()) {
    _DevLogger?.log('billing_skipped',
      `BILLING SKIPPED (dev mode) — ${jobKey} · ${usageSeconds}s · tier=${tier}`,
    );
    console.log(`[UsageDedup] DEV — billing skipped: ${jobKey} (${usageSeconds}s)`);
    return true;
  }

  // 0. Hydration race guard
  if (!_hydrated) {
    if (_hydratePromise) {
      await _hydratePromise;
    } else {
      _hydratePromise = hydrateUsageDedup();
      await _hydratePromise;
    }
  }

  // 1. Memory check
  if (_usageRecorded.has(jobKey)) {
    console.log(`[UsageDedup] Skipped (memory): ${jobKey}`);
    return false;
  }

  // 1a. [FIX-13 v14] in-flight check
  if (_billingInFlight.has(jobKey)) {
    console.log(`[UsageDedup] Skipped (in-flight): ${jobKey}`);
    return false;
  }

  // 2+3. [FIX-10 v13] _hydrated=true면 disk check 생략
  if (!_hydrated) {
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

    if (_usageRecorded.has(jobKey) || _billingInFlight.has(jobKey)) {
      console.log(`[UsageDedup] Skipped (race): ${jobKey}`);
      return false;
    }
  }

  // 4. pending 등록
  _billingInFlight.add(jobKey);

  try {
    // 5. memory write
    registerJobKey(jobKey);

    // 6. BILLING ← BEFORE persist
    recordUsageFn(usageSeconds);
    recordGpuSecondsFn(usageSeconds, tier).catch(() => {});
    console.log(`[UsageDedup] Billed: ${jobKey} (${usageSeconds}s)`);

    // 7. persist micro-await (50ms budget)
    const persistPromise = _persistDedupAsync();
    await Promise.race([
      persistPromise,
      new Promise<void>(res => setTimeout(res, PERSIST_MICRO_AWAIT_MS)),
    ]);
    persistPromise.catch(e => {
      console.warn(
        '[UsageDedup] Persist failed (billing already done — dedup may miss on restart):',
        e,
      );
    });

  } finally {
    // 8. pending 해제
    _billingInFlight.delete(jobKey);
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_KEY          = 'server_bridge_config';
const DEFAULT_TIMEOUT_MS  = 120_000;
const MAX_RETRIES         = 3;
const RETRY_DELAY_BASE_MS = 1000;

/**
 * RATE_LIMIT_MAX_DELAY_MS — 429 Retry-After 상한 [FIX-14 v14]
 */
const RATE_LIMIT_MAX_DELAY_MS = 30_000;

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
// [FIX-11 v13] Concurrency: transcribe / translate 큐 분리
// [FIX-16 v15] translate → PriorityQueue 기반 short-first semaphore
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TRANSCRIBE_INFLIGHT = 4;
const MAX_TRANSLATE_INFLIGHT  = 2;

/** FIFO semaphore — transcribe 전용 (순서 의존성 있음, FIFO 유지) */
function createSemaphore(maxSlots: number) {
  let count = 0;
  const queue: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (count < maxSlots) { count++; return; }
    await new Promise<void>(resolve => queue.push(resolve));
    count++;
  }

  function release(): void {
    count = Math.max(0, count - 1);
    const next = queue.shift();
    if (next) next();
  }

  return { acquire, release };
}

/**
 * [FIX-16 v15] PriorityTranslateSemaphore — short-first (min reservedSeconds)
 *
 * 설계 원칙:
 *   - 슬롯 수(maxSlots) 변경 없음 → concurrency 동일
 *   - 대기 중인 waiter를 reservedSeconds 오름차순(min-heap)으로 정렬
 *   - 짧은 job이 긴 job보다 먼저 슬롯 획득 → 평균 latency 감소
 *
 * 기아(starvation) 방지:
 *   - 짧은 job이 계속 enqueue되어도 긴 job은 대기열에 남아있고
 *     결국 앞으로 이동함 (무한 starvation 구조적으로 불가)
 *   - reservedSeconds=Infinity로 enqueue하면 일반 batch보다 뒤로 밀리지만
 *     대기열은 유한하므로 deadlock 없음
 *
 * acquire(reservedSeconds):
 *   - 슬롯 여유 있으면 즉시 획득
 *   - 없으면 min-heap에 삽입, 슬롯 반환 시 가장 작은 waiter가 깨어남
 *
 * release():
 *   - count 감소 후 heap에서 최소값 pop → resolve 호출
 */
function createPriorityTranslateSemaphore(maxSlots: number) {
  let count = 0;

  // min-heap: [reservedSeconds, resolve]
  // 단순 정렬 배열로 구현 — 최대 대기 수 통상 10 미만이므로 O(n log n) 충분
  const heap: Array<{ priority: number; resolve: () => void }> = [];

  function heapPush(item: { priority: number; resolve: () => void }): void {
    heap.push(item);
    // sift up
    let i = heap.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (heap[parent].priority <= heap[i].priority) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  function heapPop(): { priority: number; resolve: () => void } | undefined {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      // sift down
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < heap.length && heap[l].priority < heap[smallest].priority) smallest = l;
        if (r < heap.length && heap[r].priority < heap[smallest].priority) smallest = r;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      }
    }
    return top;
  }

  /**
   * @param reservedSeconds — 우선순위 기준. 작을수록 먼저 처리.
   *   값이 없거나 불확실하면 Infinity 전달 → 뒤로 밀림, deadlock 없음.
   */
  async function acquire(reservedSeconds = Infinity): Promise<void> {
    if (count < maxSlots) {
      count++;
      return;
    }
    await new Promise<void>(resolve => heapPush({ priority: reservedSeconds, resolve }));
    count++;
  }

  function release(): void {
    count = Math.max(0, count - 1);
    const next = heapPop();
    if (next) next.resolve();
  }

  /** 디버깅용 — 현재 대기열 크기 */
  function waitingCount(): number {
    return heap.length;
  }

  return { acquire, release, waitingCount };
}

const _transcribeSemaphore = createSemaphore(MAX_TRANSCRIBE_INFLIGHT);
const _translateSemaphore  = createPriorityTranslateSemaphore(MAX_TRANSLATE_INFLIGHT);

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate job protection — atomic pattern (RULE 5)
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
  // TODO: POST /jobs/:id/cancel 서버 cancel API
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchWithRetry
// [FIX-14 v14] 429 Retry-After 헤더 처리
// [SELF-1 v9]  AbortController 누수 방지
// ─────────────────────────────────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  options: Omit<RequestInit, 'signal'>,
  timeoutMs: number,
  retries = MAX_RETRIES,
): Promise<Response> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller      = new AbortController();
    _activeControllers.add(controller);
    const effectiveTimeout = attempt <= 1 ? Math.max(timeoutMs, 30_000) : timeoutMs;
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    const _t0 = __DEV__ ? Date.now() : 0;
    if (__DEV__) {
      _DevLogger?.log('request_start',
        `→ ${(options.method ?? 'GET')} ${url.split('/').pop() ?? url} (attempt ${attempt + 1})`,
        { detail: url, attempt },
      );
    }

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });

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
      const text     = await response.text().catch(() => '');

      if (errClass === 'auth' || errClass === 'validation') {
        const fatalErr = new Error(`Server returned ${response.status}: ${text}`);
        (fatalErr as any).status = response.status;
        throw fatalErr;
      }

      // [FIX-14 v14] 429: Retry-After 헤더 기반 delay
      if (response.status === 429 && attempt < retries) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSecs   = retryAfterHeader ? parseFloat(retryAfterHeader) : NaN;
        const retryDelayMs = !isNaN(retryAfterSecs)
          ? Math.min(retryAfterSecs * 1000, RATE_LIMIT_MAX_DELAY_MS)
          : Math.min(RETRY_DELAY_BASE_MS * Math.pow(2, attempt), RATE_LIMIT_MAX_DELAY_MS);
        console.warn(
          `[ServerBridge] 429 rate limit — waiting ${retryDelayMs}ms ` +
          `(Retry-After: ${retryAfterHeader ?? 'none'})`,
        );
        lastError = new Error(`Rate limited (429): ${text}`);
        (lastError as any).status = 429;
        clearTimeout(timer);
        _activeControllers.delete(controller);
        await new Promise(r => setTimeout(r, retryDelayMs));
        continue;
      }

      lastError = new Error(`Server error ${response.status}: ${text}`);
      (lastError as any).status = response.status;

    } catch (e: any) {
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
    } finally {
      // [SELF-1 v9] 누수 방지
      clearTimeout(timer);
      _activeControllers.delete(controller);
    }

    if (attempt < retries) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_BASE_MS * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchCompletedBatches
// ─────────────────────────────────────────────────────────────────────────────

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

    const data    = await response.json();
    const indices: number[]             = data.completedBatchIndices ?? [];
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
// serverTranscribe — FIFO semaphore (순서 의존성 유지)
// ─────────────────────────────────────────────────────────────────────────────

export async function serverTranscribe(
  request: ServerTranscribeRequest,
): Promise<ServerTranscribeResponse> {
  const config = await loadServerBridgeConfig();
  if (!config) throw new Error('[ServerBridge] Not configured.');

  await _transcribeSemaphore.acquire();
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
    if (typeof data.usageSeconds !== 'number') {
      const span = data.segments.length > 0
        ? (data.segments[data.segments.length - 1].end - data.segments[0].start)
        : 30;
      data.usageSeconds = Math.ceil(span);
    }
    return data as ServerTranscribeResponse;
  } finally {
    _transcribeSemaphore.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// serverTranslate
// [FIX-16 v15] priority semaphore — reservedSeconds 기준 short-first
// [FIX-15 v14] billing invariant 위반 시 보수적 billing
// [FIX-2 v9]   atomic dedup
// ─────────────────────────────────────────────────────────────────────────────

export async function serverTranslate(
  request: ServerTranslateRequest,
): Promise<ServerTranslateResponse> {
  if (_activeJobs.has(request.videoId)) {
    console.log(`[ServerBridge] Dedup: returning existing job for ${request.videoId}`);
    return _activeJobs.get(request.videoId)!;
  }

  const jobPromise = (async () => {
    try {
      return await _serverTranslateImpl(request);
    } finally {
      _activeJobs.delete(request.videoId);
    }
  })();

  _activeJobs.set(request.videoId, jobPromise);
  return jobPromise;
}

async function _serverTranslateImpl(
  request: ServerTranslateRequest,
): Promise<ServerTranslateResponse> {
  const config = await loadServerBridgeConfig();
  if (!config) throw new Error('[ServerBridge] Not configured.');

  // [FIX-16 v15] reservedSeconds 기준 short-first 획득
  // 대기열에서 가장 짧은 job 먼저 슬롯 획득 → 평균 latency 감소
  await _translateSemaphore.acquire(request.reservedSeconds);

  if (__DEV__) {
    console.log(
      `[ServerBridge] translate slot acquired: ` +
      `videoId=${request.videoId}, ` +
      `reservedSeconds=${request.reservedSeconds}, ` +
      `queueWaiting=${_translateSemaphore.waitingCount()}`,
    );
  }

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

    if (typeof data.usageSeconds !== 'number') {
      throw new Error(
        '[ServerBridge] Missing usageSeconds in server response — billing contract violation.'
      );
    }

    if (typeof data.reservedSeconds !== 'number') {
      data.reservedSeconds = request.reservedSeconds;
      console.warn('[ServerBridge] reservedSeconds missing in response — using request value as fallback');
    }

    // [FIX-15 v14] billing invariant 위반 시 보수적 billing
    if (data.usageSeconds > data.reservedSeconds) {
      const billedSeconds = Math.min(data.usageSeconds, data.reservedSeconds);
      console.error(
        `[ServerBridge] billing invariant violated: ` +
        `actualSeconds(${data.usageSeconds}) > reservedSeconds(${data.reservedSeconds}) — ` +
        `billing conservatively as min(actual, reserved) = ${billedSeconds}s ` +
        `(server-side guard failure)`,
      );
      data.usageSeconds = billedSeconds;
    }

    if (typeof data.completed !== 'boolean') data.completed = true;
    return data as ServerTranslateResponse;
  } finally {
    _translateSemaphore.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

export function makeStableVideoId(videoUri: string): string {
  try {
    const decoded          = decodeURIComponent(videoUri);
    const withoutFragment  = decoded.split('#')[0];
    const parts            = withoutFragment.replace(/\\/g, '/').split('/');
    const filename         = parts[parts.length - 1] ?? videoUri;
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

/**
 * serverTranslateYoutubeSegments
 * Translate-only path for YouTube videos that have manual subtitles.
 * Called when timedtext track exists — no audio extraction, no Whisper STT.
 * GPU billing applies (Standard/Pro plans only — caller must enforce plan gate).
 */
export async function serverTranslateYoutubeSegments(
  segments: Array<{ start: number; end: number; text: string }>,
  targetLanguage: string,
  videoId: string,
  reservedSeconds: number,
): Promise<ServerTranslateResponse> {
  // Reuse existing serverTranslate — same billing contract, same semaphore
  return serverTranslate({
    segments,
    targetLanguage,
    videoId,
    reservedSeconds,
  });
}