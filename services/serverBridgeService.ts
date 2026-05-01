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
 * ── CHANGES (v14) ─────────────────────────────────────────────────────────────
 *
 * [FIX-12] getEffectiveBatchDuration: adaptive floor ratio (과대 예약 방지)
 *
 *   v13: floor = max(actual, MIN_EXECUTION_FLOOR, planned * 0.5) 고정 비율
 *        문제: planned=30, actual=5 (chunk failure 심함)
 *              → floor = max(5, 3, 15) = 15 → effective = 15
 *              → 실제 workload 5s인데 15s로 inflate → 3x 과대 예약
 *              → calcReservedSeconds buffer(×1.2)까지 붙어 quota drain 가속
 *
 *   v14: failureRatio = actual / planned 기반 동적 비율
 *        failureRatio > 0.7 → ratio 0.5 (정상 범위 — 보호 유지)
 *        failureRatio > 0.4 → ratio 0.35 (중간 failure — 절충)
 *        failureRatio ≤ 0.4 → ratio 0.2 (심한 failure — 과대 예약 억제)
 *
 *        예시 (planned=30):
 *          actual=25 (ratio=0.83) → dynamicRatio=0.5 → floor=max(25,3,15)=25 → effective=25
 *          actual=15 (ratio=0.5)  → dynamicRatio=0.35→ floor=max(15,3,10.5)=15→ effective=15
 *          actual=5  (ratio=0.17) → dynamicRatio=0.2 → floor=max(5,3,6)=6   → effective=6
 *
 *        불변식: 반환값 ≤ plannedDurationSecs (유지)
 *
 * [FIX-13] safeRecordUsage: persist micro-await (50ms) + _billingInFlight pending set
 *
 *   v13: persist fire-and-forget
 *        문제: billing 성공 → 앱 강제 종료(persist 전) → 재시작 → dedup miss → 중복 billing
 *             모바일 환경에서 이 케이스 실제로 발생 가능
 *
 *   v14:
 *     (a) persist micro-await: 50ms budget — UX 영향 최소, persist 성공률 크게 향상
 *         await Promise.race([_persistDedupAsync(), sleep(50)])
 *         → 50ms 내 완료 가능성 높음 (AsyncStorage write는 통상 <10ms)
 *         → 50ms 초과 시 fire-and-forget으로 fallback (기존과 동일)
 *
 *     (b) _billingInFlight pending set: race + crash 복합 케이스 방어
 *         billing 중인 jobKey를 동시 호출에서도 dedup
 *         registerJobKey 이전 시점의 race window 제거
 *
 * [FIX-14] fetchWithRetry: 429 (rate limit) 처리 추가
 *
 *   v13: 429 분류 없음 → unknown으로 처리
 *        문제: RunPod rate limit 시 즉시 재시도 → 429 루프 악화
 *
 *   v14: 429 → 'retryable' 분류
 *        Retry-After 헤더 있으면 해당 delay 사용
 *        없으면 exponential backoff (기존)
 *        Max delay cap: 30s (무한 대기 방지)
 *
 * [FIX-15] serverTranslate: billing invariant 위반 시 보수적 billing
 *
 *   v13: usageSeconds > reservedSeconds → 로그만 찍고 계속 진행
 *        문제: 서버 버그 시 billing contract 깨짐 → quota 무력화 위험
 *
 *   v14: usageSeconds > reservedSeconds → 보수적으로 min(actual, reserved) 사용
 *        throw하면 fallback 타서 GPU 재실행 비용 발생 → 보수적 billing이 더 합리적
 *        로그 레벨 유지 + billedSeconds 명시적으로 기록
 *
 * v13에서 유지되는 것들:
 *   - [FIX-9 v13] getEffectiveBatchDuration 3중 floor 구조 (adaptive로 교체)
 *   - [FIX-10 v13] safeRecordUsage hydrate 이후 disk read 생략
 *   - [FIX-11 v13] transcribe/translate 큐 분리 (FIFO 유지)
 *   - [FIX-7 v12] calcReservedSeconds 구조 전체
 *   - [FIX-1~6] v9~v11 전체 유지
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
 *
 * 근거:
 *   - failure 심할수록 서버 실제 workload가 actual에 가까워짐
 *   - planned 기반 floor를 줄여야 quota drain 속도 정상화
 *   - 0.2 하한: 완전히 0으로 내리면 MIN_EXECUTION_FLOOR만 남아
 *               서버 warmup 비용조차 못 커버하는 경우 방지
 */
export const ADAPTIVE_FLOOR_RATIOS = {
  HIGH: { threshold: 0.7, ratio: 0.5 },   // failureRatio > 0.7
  MID:  { threshold: 0.4, ratio: 0.35 },  // failureRatio > 0.4
  LOW:  { ratio: 0.2 },                    // failureRatio ≤ 0.4
} as const;

/**
 * getAdaptiveFloorRatio — failureRatio 기반 planned floor 비율 선택
 */
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

/**
 * getEffectiveBatchDuration
 *
 * [FIX-12 v14] adaptive floor ratio — failure 심도에 따라 planned floor 동적 조정
 * [FIX-9 v13]  3중 floor 구조 (구조 유지, ratio만 dynamic으로 교체)
 * [FIX-7 v12]  planned vs actual 분리 + floor+clamp 기반
 *
 * 일반 batch: plannedDurationSecs 그대로 반환
 *
 * 마지막 partial batch:
 *   dynamicRatio = getAdaptiveFloorRatio(actual, planned)
 *   floor = max(actual, MIN_EXECUTION_FLOOR, planned * dynamicRatio)
 *   effective = min(planned, floor)
 *
 * 예시 (planned=30):
 *   actual=25 (ratio=0.83) → dynamicRatio=0.5  → effective=min(30,max(25,3,15))=25
 *   actual=15 (ratio=0.5)  → dynamicRatio=0.35 → effective=min(30,max(15,3,10.5))=15
 *   actual=5  (ratio=0.17) → dynamicRatio=0.2  → effective=min(30,max(5,3,6))=6
 *   actual=1  (ratio=0.03) → dynamicRatio=0.2  → effective=min(6,max(1,3,1.2))=3
 *
 * 불변식: 반환값 ≤ plannedDurationSecs
 */
export function getEffectiveBatchDuration(
  plannedDurationSecs: number,
  actualDurationSecs: number,
  isLastPartialBatch: boolean,
): number {
  if (!isLastPartialBatch) {
    return plannedDurationSecs;
  }

  const dynamicRatio = getAdaptiveFloorRatio(actualDurationSecs, plannedDurationSecs);
  const plannedBasedFloor = plannedDurationSecs * dynamicRatio;
  const floored = Math.max(
    actualDurationSecs,
    MIN_EXECUTION_FLOOR_SECS,
    plannedBasedFloor,
  );

  return Math.min(plannedDurationSecs, floored);
}

// ─────────────────────────────────────────────────────────────────────────────
// calcReservedSeconds — 배치별 hard stop 기준값 계산
// ─────────────────────────────────────────────────────────────────────────────

const RESERVED_SECONDS_HARD_CAP = 3600;
const RESERVED_SECONDS_BUFFER   = 1.2;

/**
 * calcReservedSeconds
 *
 * [FIX-8 v12] 입력: effectiveDurationSecs = getEffectiveBatchDuration() 결과
 * [FIX-6 v11] isLastPartialBatch=true 시 buffer 없이 clamp (유지)
 *
 * 불변식: 반환값 ≤ remainingQuotaSeconds
 */
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
// RULE 11: Server error classification
// [FIX-14 v14] 429 (rate limit) 처리 추가
// ─────────────────────────────────────────────────────────────────────────────

export type ServerErrorClass = 'retryable' | 'auth' | 'validation' | 'unknown';

export function classifyServerError(err: any): ServerErrorClass {
  const status = err?.status ?? err?.statusCode ?? 0;
  const msg = (err?.message ?? '').toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 422) return 'validation';
  if (
    status === 429 ||   // [FIX-14 v14] rate limit → retryable (Retry-After delay 적용)
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

/**
 * PERSIST_MICRO_AWAIT_MS — persist micro-await 예산 [FIX-13 v14]
 *
 * AsyncStorage write 통상 <10ms → 50ms 내 완료 가능성 높음
 * 50ms 초과 시 fire-and-forget으로 자동 fallback
 * UX 영향 거의 없으면서 persist 성공률 크게 향상
 */
const PERSIST_MICRO_AWAIT_MS = 50;

export const _usageRecorded = new Map<string, number>();

/**
 * _billingInFlight — billing 중인 jobKey pending set [FIX-13 v14]
 *
 * registerJobKey 이전 시점의 race window 제거:
 *   - memory check 통과 → billing 중인데 동시 호출이 동일 jobKey로 진입
 *   - registerJobKey 이전이므로 memory check도 통과 → 중복 billing
 * _billingInFlight로 이 window를 원자적으로 방어
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
 *
 * Execution order (v14):
 * 0. Hydration race guard
 * 1. Memory check (sync fast path)
 * 1a. _billingInFlight check (race window 방어) — [FIX-13 v14]
 * 2. [_hydrated=false만] Disk check
 * 3. [_hydrated=false만] Race-check after await gap
 * 4. _billingInFlight.add (pending 등록) — [FIX-13 v14]
 * 5. registerJobKey (memory write)
 * 6. BILLING ← BEFORE persist
 * 7. Persist micro-await (50ms budget) — [FIX-13 v14]
 * 8. _billingInFlight.delete (pending 해제) — [FIX-13 v14]
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

  // 1. Memory check — hydrated 이후에는 항상 여기서 결정 (disk read 없음)
  if (_usageRecorded.has(jobKey)) {
    console.log(`[UsageDedup] Skipped (memory): ${jobKey}`);
    return false;
  }

  // 1a. [FIX-13 v14] _billingInFlight check — registerJobKey 이전 race window 방어
  if (_billingInFlight.has(jobKey)) {
    console.log(`[UsageDedup] Skipped (in-flight): ${jobKey}`);
    return false;
  }

  // 2+3. [FIX-10 v13] _hydrated=true면 disk check 완전 생략
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

    // Race-check: disk check await gap에서 다른 caller가 먼저 등록했을 수 있음
    if (_usageRecorded.has(jobKey) || _billingInFlight.has(jobKey)) {
      console.log(`[UsageDedup] Skipped (race): ${jobKey}`);
      return false;
    }
  }

  // 4. [FIX-13 v14] pending 등록 — billing 시작 전 선점
  _billingInFlight.add(jobKey);

  try {
    // 5. registerJobKey (memory write)
    registerJobKey(jobKey);

    // 6. BILLING ← BEFORE persist (의도된 설계)
    recordUsageFn(usageSeconds);
    recordGpuSecondsFn(usageSeconds, tier).catch(() => {});
    console.log(`[UsageDedup] Billed: ${jobKey} (${usageSeconds}s)`);

    // 7. [FIX-13 v14] persist micro-await (50ms budget)
    //    50ms 내 완료 가능성 높음 (AsyncStorage write 통상 <10ms)
    //    50ms 초과 시 자동 fallback — fire-and-forget으로 전환
    const persistPromise = _persistDedupAsync();
    await Promise.race([
      persistPromise,
      new Promise<void>(res => setTimeout(res, PERSIST_MICRO_AWAIT_MS)),
    ]);
    // 50ms 내 완료 못 했어도 백그라운드 계속 진행 (로그 추가)
    persistPromise.catch(e => {
      console.warn(
        '[UsageDedup] Persist failed (billing already done — dedup may miss on restart):',
        e,
      );
    });

  } finally {
    // 8. [FIX-13 v14] pending 해제 — 성공/실패 모든 경로
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
 * Retry-After가 비정상적으로 크면 무한 대기 방지
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
// [FIX-11 v13] Concurrency: transcribe / translate 큐 분리 (FIFO 유지)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TRANSCRIBE_INFLIGHT = 4;
const MAX_TRANSLATE_INFLIGHT  = 2;

/** FIFO semaphore — slot 수 초과 시 resolve queue로 대기 */
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

const _transcribeSemaphore = createSemaphore(MAX_TRANSCRIBE_INFLIGHT);
const _translateSemaphore  = createSemaphore(MAX_TRANSLATE_INFLIGHT);

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate job protection — atomic pattern (RULE 5)
// [FIX-2 v9] race condition 수정
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
  // 현재 HTTP abort는 클라이언트 연결만 끊음 — 서버 GPU는 계속 실행 가능
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchWithRetry
// [FIX-14 v14] 429 Retry-After 헤더 처리 추가
// [SELF-1 v9]  AbortController 누수 방지 — try/finally로 해제 보장
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
      const text = await response.text().catch(() => '');

      if (errClass === 'auth' || errClass === 'validation') {
        const fatalErr = new Error(`Server returned ${response.status}: ${text}`);
        (fatalErr as any).status = response.status;
        throw fatalErr;
      }

      // [FIX-14 v14] 429: Retry-After 헤더 기반 delay
      if (response.status === 429 && attempt < retries) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSecs = retryAfterHeader ? parseFloat(retryAfterHeader) : NaN;
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
      // [SELF-1 v9] 성공/실패 모든 경로에서 해제 — 누수 방지
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
// fetchCompletedBatches — 3-state result (RULE 4 + RULE 6)
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
// serverTranscribe — [FIX-11 v13] transcribeSemaphore 사용
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
// [FIX-15 v14] billing invariant 위반 시 보수적 billing
// [FIX-2 v9]   atomic dedup — race condition 수정
// [FIX-11 v13] translateSemaphore 사용
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

  await _translateSemaphore.acquire();
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

    // STRICT: usageSeconds 누락 → billing contract violation
    if (typeof data.usageSeconds !== 'number') {
      throw new Error(
        '[ServerBridge] Missing usageSeconds in server response — billing contract violation.'
      );
    }

    // reservedSeconds 누락 시 요청값으로 fallback (하위 호환)
    if (typeof data.reservedSeconds !== 'number') {
      data.reservedSeconds = request.reservedSeconds;
      console.warn('[ServerBridge] reservedSeconds missing in response — using request value as fallback');
    }

    // [FIX-15 v14] actualSeconds > reservedSeconds 불변식 위반 시 보수적 billing
    //
    // throw → fallback 타면 GPU 재실행 비용 발생 (더 비쌈)
    // 보수적 billing (min 사용): quota는 서버 guard 실패만큼만 drain
    // 로그로 서버 버그 추적 유지
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