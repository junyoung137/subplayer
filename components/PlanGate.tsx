import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { usePlanStore } from '../store/usePlanStore';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

interface PlanGateProps {
  requiredPlan?: 'standard' | 'pro';
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function PlanGate({ requiredPlan, children, fallback }: PlanGateProps) {
  const tier        = usePlanStore((s) => s.tier);
  const usedMinutes = usePlanStore((s) => s.usedMinutes);
  const limits      = usePlanStore((s) => s.limits);

  if (!requiredPlan) {
    if (tier === 'free' && usedMinutes >= limits.dailyCapMinutes) {
      return <>{fallback ?? <CapReachedBanner usedMinutes={usedMinutes} capMinutes={limits.dailyCapMinutes} />}</>;
    }
    return <>{children}</>;
  }

  const planRank: Record<string, number> = { free: 0, standard: 1, pro: 2 };
  if (planRank[tier] < planRank[requiredPlan]) {
    return <>{fallback ?? <UpgradeBanner requiredPlan={requiredPlan} />}</>;
  }
  return <>{children}</>;
}

function CapReachedBanner({ usedMinutes, capMinutes }: { usedMinutes: number; capMinutes: number }) {
  const { t } = useTranslation();
  const remaining = Math.max(0, capMinutes - usedMinutes);
  return (
    <View style={s.banner}>
      <Text style={s.title}>{t('plan.capReachedTitle', { cap: capMinutes })}</Text>
      <Text style={s.sub}>{remaining > 0 ? t('plan.capRemainingToday', { remaining: Math.floor(remaining) }) : t('plan.capResetsTomorrow')}</Text>
      <Text style={s.sub}>{t('plan.autoSaveNote')}</Text>
      <TouchableOpacity style={s.btn} onPress={() => router.push('/settings')}>
        <Text style={s.btnText}>{t('plan.upgrade')}</Text>
      </TouchableOpacity>
    </View>
  );
}

function UpgradeBanner({ requiredPlan }: { requiredPlan: string }) {
  const { t } = useTranslation();
  return (
    <View style={s.banner}>
      <Text style={s.title}>{requiredPlan === 'pro' ? t('plan.proRequired') : t('plan.standardRequired')}</Text>
      <Text style={s.sub}>{t('plan.paidFeatureNote')}</Text>
      <TouchableOpacity style={s.btn} onPress={() => router.push('/settings')}>
        <Text style={s.btnText}>{t('plan.viewPlans')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  banner: { backgroundColor: '#1a1a2e', borderRadius: 12, padding: 20, margin: 16, alignItems: 'center', borderWidth: 1, borderColor: '#312e81' },
  title:  { color: '#a5b4fc', fontSize: 15, fontWeight: '700', marginBottom: 6 },
  sub:    { color: '#6366f1', fontSize: 12, textAlign: 'center', marginBottom: 4 },
  btn:    { backgroundColor: '#4f46e5', borderRadius: 20, paddingHorizontal: 24, paddingVertical: 10, marginTop: 10 },
  btnText:{ color: '#fff', fontSize: 13, fontWeight: '600' },
});
