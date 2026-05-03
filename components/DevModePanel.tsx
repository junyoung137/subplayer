/**
 * DevModePanel.tsx
 * Developer Test Mode v2 — Status Dashboard + Usage Simulator + Live Request Monitor
 *
 * Triple production safety lock:
 *   1. Returns null immediately when !__DEV__
 *   2. DevConfig/DevLogger methods are no-ops in production
 *   3. AsyncStorage keys use __dev__ namespace
 *
 * Sections:
 *   [STATUS]    — current plan/usage/limits display
 *   [PLAN]      — plan override selector
 *   [USAGE]     — usage simulator (slider + manual)
 *   [RESET]     — monthly reset simulator
 *   [EXPIRY]    — subscription expiry simulator
 *   [SERVER]    — GPU server endpoint + API key override
 *   [LOG]       — live request/billing event log
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Switch,
  TouchableOpacity, TextInput, Alert,
} from 'react-native';
import { usePlanStore } from '../store/usePlanStore';
import { useSettingsStore } from '../store/useSettingsStore';

// ── Types (resolved lazily so production bundle never loads dev modules) ──────

type DevConfigState = import('../utils/devConfig').DevConfigState;
type DevLogEvent    = import('../utils/devLogger').DevLogEvent;

// ─────────────────────────────────────────────────────────────────────────────

export function DevModePanel() {
  // Triple lock #1 — never render in production
  if (!__DEV__) return null;

  return <DevModePanelInner />;
}

function DevModePanelInner() {
  const [devState, setDevState]   = useState<DevConfigState | null>(null);
  const [logEvents, setLogEvents] = useState<DevLogEvent[]>([]);
  const [endpointInput, setEndpointInput] = useState('');
  const [apiKeyInput, setApiKeyInput]     = useState('');
  const [usageInput, setUsageInput]       = useState('');
  const [modules, setModules] = useState<{
    DevConfig: typeof import('../utils/devConfig').DevConfig;
    DevLogger: typeof import('../utils/devLogger').DevLogger;
  } | null>(null);

  const tier        = usePlanStore((s) => s.tier);
  const usedMinutes = usePlanStore((s) => s.usedMinutes);
  const limits      = usePlanStore((s) => s.limits);
  const syncFromSettings = usePlanStore((s) => s.syncFromSettings);
  const planExpiresAt    = useSettingsStore((s) => s.planExpiresAt);

  // Load dev modules once
  useEffect(() => {
    Promise.all([
      import('../utils/devConfig'),
      import('../utils/devLogger'),
    ]).then(([dc, dl]) => {
      setModules({ DevConfig: dc.DevConfig, DevLogger: dl.DevLogger });
      // Subscribe to config changes
      dc.DevConfig.subscribe(state => {
        setDevState({ ...state });
        setEndpointInput(state.endpointOverride ?? '');
        setApiKeyInput(state.apiKeyOverride ?? '');
        setUsageInput(state.usageMinutesOverride !== null ? String(Math.round(state.usageMinutesOverride)) : '');
      });
      // Subscribe to log events
      dl.DevLogger.subscribe(events => setLogEvents([...events].reverse()));
    }).catch(() => {});
  }, []);

  const { DevConfig, DevLogger } = modules ?? {};

  const toggleDevMode = useCallback(async (val: boolean) => {
    await DevConfig?.set({ devModeEnabled: val });
    // Re-sync plan store so overrides take effect immediately
    syncFromSettings();
  }, [DevConfig, syncFromSettings]);

  const applyPlanOverride = useCallback(async (plan: DevConfigState['planOverride']) => {
    await DevConfig?.set({ planOverride: plan });
    syncFromSettings();
  }, [DevConfig, syncFromSettings]);

  const applyUsageOverride = useCallback(async () => {
    const val = parseFloat(usageInput);
    await DevConfig?.set({ usageMinutesOverride: isNaN(val) ? null : val });
  }, [DevConfig, usageInput]);

  const applyServerConfig = useCallback(async () => {
    await DevConfig?.set({
      endpointOverride: endpointInput.trim() || null,
      apiKeyOverride: apiKeyInput.trim() || null,
    });
    Alert.alert('개발 모드', '서버 설정이 저장되었습니다. 설정이 캐시된 경우 앱을 재시작하세요.');
  }, [DevConfig, endpointInput, apiKeyInput]);

  const simulateExpired = useCallback(async () => {
    await DevConfig?.set({ expiresAtOverride: Date.now() - 1000 });
  }, [DevConfig]);

  const clearExpiry = useCallback(async () => {
    await DevConfig?.set({ expiresAtOverride: null });
  }, [DevConfig]);

  const simulateReset = useCallback(async () => {
    await DevConfig?.set({ resetAtOverride: Date.now() - 1000 });
  }, [DevConfig]);

  const clearReset = useCallback(async () => {
    await DevConfig?.set({ resetAtOverride: null });
  }, [DevConfig]);

  const resetAll = useCallback(async () => {
    await DevConfig?.reset();
    DevLogger?.clear();
    syncFromSettings();
  }, [DevConfig, DevLogger, syncFromSettings]);

  if (!devState) {
    return (
      <View style={s.container}>
        <Text style={s.loadingText}>개발 설정 불러오는 중...</Text>
      </View>
    );
  }

  const effectiveUsed = devState.devModeEnabled && devState.usageMinutesOverride !== null
    ? devState.usageMinutesOverride
    : usedMinutes;

  const effectiveExpires = devState.devModeEnabled && devState.expiresAtOverride !== null
    ? devState.expiresAtOverride
    : planExpiresAt;

  const planColors: Record<string, string> = { free: '#64748b', lite: '#7a5ab0', standard: '#6366f1', pro: '#f59e0b' };

  return (
    <ScrollView style={s.container} showsVerticalScrollIndicator={false}>
      {/* ── Header ── */}
      <View style={s.header}>
        <Text style={s.headerTitle}>🛠 개발자 테스트 모드</Text>
        <View style={s.headerRow}>
          <Text style={s.headerSub}>v2 — 프로덕션 삼중 잠금 활성</Text>
          <Switch
            value={devState.devModeEnabled}
            onValueChange={toggleDevMode}
            thumbColor={devState.devModeEnabled ? '#6366f1' : '#444'}
            trackColor={{ false: '#333', true: '#312e81' }}
          />
        </View>
      </View>

      {/* ── [STATUS] Current state ── */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>현황</Text>
        <View style={s.statusGrid}>
          <StatusCell label="Plan" value={tier.toUpperCase()} color={planColors[tier] ?? '#888'} />
          <StatusCell label="Used" value={`${effectiveUsed.toFixed(1)} min`} color="#22c55e" />
          <StatusCell
            label={tier === 'free' ? '일일 한도' : '월 한도'}
            value={tier === 'free' ? `${limits.dailyCapMinutes} min` : `${limits.monthlyCapMinutes / 60} h`}
            color="#94a3b8"
          />
          <StatusCell
            label="만료"
            value={effectiveExpires
              ? (Date.now() > effectiveExpires ? '만료됨' : new Date(effectiveExpires).toLocaleDateString())
              : '없음'}
            color={effectiveExpires && Date.now() > effectiveExpires ? '#ef4444' : '#94a3b8'}
          />
        </View>
        {!devState.devModeEnabled && (
          <Text style={s.disabledNote}>위에서 개발 모드를 켜면 오버라이드가 활성화됩니다</Text>
        )}
      </View>

      {/* ── [PLAN] Plan override ── */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>플랜 오버라이드</Text>
        <View style={s.chipRow}>
          {(['free', 'lite', 'standard', 'pro', null] as const).map(plan => (
            <TouchableOpacity
              key={String(plan)}
              style={[s.chip, devState.planOverride === plan && s.chipActive]}
              onPress={() => applyPlanOverride(plan)}
              disabled={!devState.devModeEnabled}
            >
              <Text style={[s.chipText, devState.planOverride === plan && s.chipTextActive]}>
                {plan === null ? '실제' : plan.charAt(0).toUpperCase() + plan.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* ── [USAGE] Usage simulator ── */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>사용량 시뮬레이터</Text>
        <View style={s.row}>
          <TextInput
            style={[s.input, s.inputFlex]}
            value={usageInput}
            onChangeText={setUsageInput}
            placeholder="분 단위 (예: 19.5)"
            placeholderTextColor="#555"
            keyboardType="numeric"
            editable={devState.devModeEnabled}
          />
          <TouchableOpacity
            style={[s.btn, !devState.devModeEnabled && s.btnDisabled]}
            onPress={applyUsageOverride}
            disabled={!devState.devModeEnabled}
          >
            <Text style={s.btnText}>설정</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btn, s.btnSecondary, !devState.devModeEnabled && s.btnDisabled]}
            onPress={async () => { await DevConfig?.set({ usageMinutesOverride: null }); setUsageInput(''); }}
            disabled={!devState.devModeEnabled}
          >
            <Text style={s.btnText}>초기화</Text>
          </TouchableOpacity>
        </View>
        <Text style={s.hint}>STATUS에 표시됨. 실제 저장소는 변경되지 않음.</Text>
      </View>

      {/* ── [RESET] Monthly reset simulator ── */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>월간 리셋 시뮬레이터</Text>
        <View style={s.row}>
          <TouchableOpacity
            style={[s.btn, !devState.devModeEnabled && s.btnDisabled]}
            onPress={simulateReset}
            disabled={!devState.devModeEnabled}
          >
            <Text style={s.btnText}>리셋 실행</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btn, s.btnSecondary, !devState.devModeEnabled && s.btnDisabled]}
            onPress={clearReset}
            disabled={!devState.devModeEnabled}
          >
            <Text style={s.btnText}>초기화</Text>
          </TouchableOpacity>
        </View>
        <Text style={s.hint}>resetAt을 과거로 설정 — canProcess()가 resetMonthlyUsage()를 호출합니다.</Text>
      </View>

      {/* ── [EXPIRY] Subscription expiry simulator ── */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>만료 시뮬레이터</Text>
        <View style={s.row}>
          <TouchableOpacity
            style={[s.btn, s.btnDanger, !devState.devModeEnabled && s.btnDisabled]}
            onPress={simulateExpired}
            disabled={!devState.devModeEnabled}
          >
            <Text style={s.btnText}>만료 시뮬레이션</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btn, s.btnSecondary, !devState.devModeEnabled && s.btnDisabled]}
            onPress={clearExpiry}
            disabled={!devState.devModeEnabled}
          >
            <Text style={s.btnText}>초기화</Text>
          </TouchableOpacity>
        </View>
        <Text style={s.hint}>무료 플랜 외에서 canProcess()가 subscriptionExpired를 반환합니다.</Text>
      </View>

      {/* ── [SERVER] GPU server config override ── */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>GPU 서버 설정</Text>
        <TextInput
          style={s.input}
          value={endpointInput}
          onChangeText={setEndpointInput}
          placeholder="엔드포인트 URL (선택)"
          placeholderTextColor="#555"
          autoCapitalize="none"
          autoCorrect={false}
          editable={devState.devModeEnabled}
        />
        <TextInput
          style={[s.input, { marginTop: 6 }]}
          value={apiKeyInput}
          onChangeText={setApiKeyInput}
          placeholder="API 키 오버라이드 (선택)"
          placeholderTextColor="#555"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          editable={devState.devModeEnabled}
        />
        <TouchableOpacity
          style={[s.btn, { marginTop: 8 }, !devState.devModeEnabled && s.btnDisabled]}
          onPress={applyServerConfig}
          disabled={!devState.devModeEnabled}
        >
          <Text style={s.btnText}>서버 설정 저장</Text>
        </TouchableOpacity>
        <Text style={s.hint}>개발 모드 활성 시 loadServerBridgeConfig()에 주입됩니다.</Text>
      </View>

      {/* ── [LOG] Live event log ── */}
      <View style={s.section}>
        <View style={s.sectionHeaderRow}>
          <Text style={s.sectionTitle}>{`이벤트 로그 (${logEvents.length})`}</Text>
          <TouchableOpacity onPress={() => DevLogger?.clear()}>
            <Text style={s.clearBtn}>지우기</Text>
          </TouchableOpacity>
        </View>
        {logEvents.length === 0 ? (
          <Text style={s.emptyLog}>이벤트 없음. 개발 모드를 켜고 영상을 처리해 보세요.</Text>
        ) : (
          logEvents.slice(0, 50).map(ev => (
            <View key={ev.id} style={s.logRow}>
              <View style={[s.logDot, { backgroundColor: levelColor(ev.level) }]} />
              <View style={s.logContent}>
                <Text style={s.logTag}>[{ev.tag}]</Text>
                <Text style={[s.logMsg, { color: levelColor(ev.level) }]}>{ev.message}</Text>
                <Text style={s.logTime}>{new Date(ev.ts).toLocaleTimeString()}</Text>
              </View>
            </View>
          ))
        )}
      </View>

      {/* ── Reset all ── */}
      <TouchableOpacity style={[s.btn, s.btnDanger, s.resetAllBtn]} onPress={resetAll}>
        <Text style={s.btnText}>모든 개발 오버라이드 초기화</Text>
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

function StatusCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={s.statusCell}>
      <Text style={s.statusLabel}>{label}</Text>
      <Text style={[s.statusValue, { color }]}>{value}</Text>
    </View>
  );
}

function levelColor(level: DevLogEvent['level']): string {
  switch (level) {
    case 'billing': return '#f59e0b';
    case 'error':   return '#ef4444';
    case 'warn':    return '#f97316';
    case 'request': return '#60a5fa';
    default:        return '#94a3b8';
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: {
    backgroundColor: '#0d0d1a',
    borderRadius: 12,
    marginHorizontal: 0,
  },
  loadingText: { color: '#555', fontSize: 12, padding: 16 },
  header: {
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    padding: 16,
    marginBottom: 2,
    borderWidth: 1,
    borderColor: '#312e81',
  },
  headerTitle: { color: '#a5b4fc', fontSize: 16, fontWeight: '700' },
  headerRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  headerSub:   { color: '#4b5563', fontSize: 11 },
  section: {
    backgroundColor: '#111827',
    borderRadius: 10,
    padding: 14,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  sectionTitle:     { color: '#6b7280', fontSize: 10, fontWeight: '700', letterSpacing: 1, marginBottom: 10 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  clearBtn: { color: '#6366f1', fontSize: 12 },
  disabledNote: { color: '#374151', fontSize: 11, textAlign: 'center', marginTop: 8 },
  statusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statusCell: {
    backgroundColor: '#1f2937',
    borderRadius: 8,
    padding: 10,
    minWidth: '45%',
    flex: 1,
  },
  statusLabel: { color: '#6b7280', fontSize: 10, marginBottom: 2 },
  statusValue: { fontSize: 14, fontWeight: '700' },
  chipRow: { flexDirection: 'row', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#1f2937',
    borderWidth: 1,
    borderColor: '#374151',
  },
  chipActive: { backgroundColor: '#312e81', borderColor: '#6366f1' },
  chipText:   { color: '#9ca3af', fontSize: 13 },
  chipTextActive: { color: '#a5b4fc', fontWeight: '700' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    backgroundColor: '#1f2937',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#374151',
    color: '#e5e7eb',
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13,
  },
  inputFlex: { flex: 1 },
  btn: {
    backgroundColor: '#4f46e5',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSecondary: { backgroundColor: '#1f2937', borderWidth: 1, borderColor: '#374151' },
  btnDanger:    { backgroundColor: '#7f1d1d' },
  btnDisabled:  { opacity: 0.35 },
  btnText:      { color: '#fff', fontSize: 12, fontWeight: '600' },
  resetAllBtn:  { marginHorizontal: 14, marginTop: 8 },
  hint: { color: '#374151', fontSize: 10, marginTop: 8 },
  emptyLog: { color: '#374151', fontSize: 11, textAlign: 'center', paddingVertical: 12 },
  logRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: '#1f2937',
    gap: 8,
  },
  logDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginTop: 4,
    flexShrink: 0,
  },
  logContent: { flex: 1 },
  logTag:     { color: '#4b5563', fontSize: 10, fontWeight: '600' },
  logMsg:     { fontSize: 11, lineHeight: 16 },
  logTime:    { color: '#374151', fontSize: 9, marginTop: 1 },
});
