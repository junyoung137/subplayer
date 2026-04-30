/**
 * devLogger.ts
 * In-memory event bus for Developer Test Mode.
 *
 * Triple production safety lock:
 *   1. __DEV__ guard on every method — all calls are no-ops in production builds
 *   2. DevModePanel renders null unless __DEV__
 *   3. AsyncStorage keys use __dev__ namespace (never conflicts with prod data)
 */

export type DevLogLevel = string; // open-ended: 'billing_skipped' | 'request_start' | etc.

export interface DevLogEvent {
  id: string;
  ts: number;
  level: DevLogLevel;
  tag: string;   // derived from level — used by DevModePanel for display
  message: string;
  data?: any;
}

type Listener = (events: DevLogEvent[]) => void;

class DevLoggerImpl {
  private events: DevLogEvent[] = [];
  private listeners = new Set<Listener>();
  private maxEvents = 200;

  // 3-argument API: log(level, message, opts?)
  // `tag` in the stored event is derived from `level` for display purposes.
  log(level: DevLogLevel, message: string, opts?: any): void {
    if (!__DEV__) return;
    const event: DevLogEvent = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      level,
      tag: level,   // tag = level — shown as "[billing_skipped]" etc. in panel
      message,
      data: opts,
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
    this._notify();
  }

  subscribe(fn: Listener): () => void {
    if (!__DEV__) return () => {};
    this.listeners.add(fn);
    fn([...this.events]); // emit current state immediately
    return () => this.listeners.delete(fn);
  }

  getEvents(): DevLogEvent[] {
    return __DEV__ ? [...this.events] : [];
  }

  getLastOf(tag: string): DevLogEvent | undefined {
    if (!__DEV__) return undefined;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].tag === tag) return this.events[i];
    }
    return undefined;
  }

  clear(): void {
    if (!__DEV__) return;
    this.events = [];
    this._notify();
  }

  private _notify(): void {
    const snap = [...this.events];
    this.listeners.forEach(fn => fn(snap));
  }
}

export const DevLogger: DevLoggerImpl = __DEV__
  ? new DevLoggerImpl()
  : (new DevLoggerImpl()); // same class — all methods guard __DEV__ internally
