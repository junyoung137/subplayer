import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
  Modal,
  Pressable,
  Alert,
  TextInput,
  ActivityIndicator,
} from "react-native";
import Slider from "@react-native-community/slider";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../store/useSettingsStore";
import { LANGUAGES } from "../constants/languages";
import { useAuthStore } from "../store/useAuthStore";
import { signOut } from "../services/authService";
import { auth } from "../services/firebase";
import { KeyRound, LogOut, Trash2, Eye, EyeOff, Check } from 'lucide-react-native';
import { DevModePanel } from '../components/DevModePanel';
import { usePlanStore } from '../store/usePlanStore';
import { useEffectiveUsedMinutes } from '../store/usePlanStore';

export default function SettingsScreen() {
  const settings = useSettingsStore();
  const { update } = settings;
  const { t } = useTranslation();

  const user   = useAuthStore((s) => s.user);
  const isPro  = useAuthStore((s) => s.isPro);

  // ── Plan / quota state ───────────────────────────────────────────────────
  const planTier     = usePlanStore((s) => s.tier);
  const planLimits   = usePlanStore((s) => s.limits);
  const resetAt      = usePlanStore((s) => s.resetAt);
  const usedMinutes  = useEffectiveUsedMinutes();

  const [langDropdownVisible, setLangDropdownVisible] = useState(false);

  // ── Password change modal state ──────────────────────────────────────────
  const [pwModalVisible, setPwModalVisible] = useState(false);
  const [currentPw,      setCurrentPw]      = useState("");
  const [newPw,          setNewPw]          = useState("");
  const [confirmPw,      setConfirmPw]      = useState("");
  const [pwError,        setPwError]        = useState("");
  const [pwSuccess,      setPwSuccess]      = useState("");
  const [pwLoading,      setPwLoading]      = useState(false);
  const [showCurrentPw,  setShowCurrentPw]  = useState(false);
  const [showNewPw,      setShowNewPw]      = useState(false);
  const [showConfirmPw,  setShowConfirmPw]  = useState(false);

  const providerId   = auth().currentUser?.providerData[0]?.providerId ?? "";
  const isGoogleUser = providerId === "google.com";
  const displayLabel = user?.displayName ?? user?.email ?? "";
  const avatarLetter = (displayLabel[0] ?? "?").toUpperCase();

  // ── Quota calculations ───────────────────────────────────────────────────
  const isFree       = planTier === 'free';
  const capMinutes   = isFree
    ? planLimits.dailyCapMinutes
    : planLimits.monthlyCapMinutes;

  const usedClamped  = Math.min(usedMinutes, capMinutes > 0 ? capMinutes : usedMinutes);
  const fillRatio    = capMinutes > 0 ? Math.min(usedClamped / capMinutes, 1) : 0;
  const remainingMin = capMinutes > 0 ? Math.max(capMinutes - usedMinutes, 0) : null;

  // 잔여 시간 텍스트
  const remainingLabel = remainingMin !== null
    ? remainingMin >= 60
      ? `${Math.floor(remainingMin / 60)}h ${Math.round(remainingMin % 60)}m ${t('settings.remaining', { defaultValue: '남음' })}`
      : `${Math.round(remainingMin)}m ${t('settings.remaining', { defaultValue: '남음' })}`
    : '∞';

  // 리셋 날짜 텍스트
  const resetLabel = resetAt
    ? new Date(resetAt).toLocaleDateString(settings.interfaceLanguage, { month: 'short', day: 'numeric' })
    : null;

  // 바 색상 — 잔여 비율 기반
  const barColor = fillRatio >= 0.9
    ? '#8b3a3a'   // 위험 (90%+ 사용)
    : fillRatio >= 0.7
      ? '#b07d2a' // 경고 (70%+ 사용)
      : '#2a3f6f'; // 정상

  const handleLogout = () => {
    Alert.alert(t("auth.logout"), t("auth.logoutConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("auth.logout"),
        style: "destructive",
        onPress: async () => {
          try {
            await signOut();
            router.replace("./login");
          } catch {}
        },
      },
    ]);
  };

  const handleDeleteAccount = () => {
    Alert.alert(t("auth.deleteAccount"), t("auth.deleteAccountConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("auth.deleteAccount"),
        style: "destructive",
        onPress: async () => {
          try {
            await auth().currentUser?.delete();
            router.replace("./login");
          } catch (e: any) {
            const msg = e?.code === "auth/requires-recent-login"
              ? t("auth.errorReauthRequired")
              : t("auth.errorDefault");
            Alert.alert(t("common.error"), msg);
          }
        },
      },
    ]);
  };

  const handleChangePassword = async () => {
    setPwError("");
    setPwSuccess("");
    if (newPw.length < 6) { setPwError(t("auth.errorPasswordShort")); return; }
    if (newPw !== confirmPw) { setPwError(t("auth.errorPasswordMismatch")); return; }
    setPwLoading(true);
    try {
      const fbUser = auth().currentUser;
      if (!fbUser || !fbUser.email) throw new Error("no-user");
      const credential = auth.EmailAuthProvider.credential(fbUser.email, currentPw);
      await fbUser.reauthenticateWithCredential(credential);
      await fbUser.updatePassword(newPw);
      setPwSuccess(t("auth.changesSaved"));
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
    } catch (e: any) {
      const code = e?.code ?? "";
      if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
        setPwError(t("auth.errorWrongCredentials"));
      } else if (code === "auth/requires-recent-login") {
        setPwError(t("auth.errorReauthRequired"));
      } else {
        setPwError(t("auth.errorDefault"));
      }
    } finally {
      setPwLoading(false);
    }
  };

  const subtitleStyles = [
    { key: "outline",  label: t("settings.outlineStyle"), desc: t("settings.outlineDesc") },
    { key: "pill",     label: t("settings.pillStyle"),    desc: t("settings.pillDesc")    },
    { key: "bar",      label: t("settings.barStyle"),     desc: t("settings.barDesc")     },
  ] as const;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

      {/* ── Account management ──────────────────────────────────────────────── */}
      <View style={styles.accountCard}>
        <Text style={styles.sectionTitle}>{t("auth.accountManagement")}</Text>

        {/* Profile row */}
        <View style={styles.accountProfileRow}>
          <View style={styles.accountAvatar}>
            <Text style={styles.accountAvatarText}>{avatarLetter}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.accountName} numberOfLines={1}>{displayLabel}</Text>
            <View style={[styles.planBadge, isPro ? styles.planBadgePro : styles.planBadgeFree]}>
              <Text style={[styles.planBadgeText, isPro ? styles.planBadgeTextPro : styles.planBadgeTextFree]}>
                {isPro ? `${t("auth.planPro")} ✓` : t("auth.planFree")}
              </Text>
            </View>
          </View>
          {isGoogleUser && (
            <View style={styles.googleBadge}>
              <Text style={styles.googleBadgeText}>G</Text>
              <Text style={styles.googleBadgeLabel}>{t("auth.googleAccount")}</Text>
            </View>
          )}
        </View>

        <View style={styles.accountDivider} />

        {/* Change password — email users only */}
        {!isGoogleUser && (
          <TouchableOpacity
            style={styles.accountRow}
            onPress={() => { setPwError(""); setPwSuccess(""); setPwModalVisible(true); }}
            activeOpacity={0.7}
          >
            <KeyRound size={18} color="#ccc" />
            <Text style={styles.accountRowText}>{t("auth.changePassword")}</Text>
            <Text style={styles.accountRowChevron}>›</Text>
          </TouchableOpacity>
        )}

        {/* Logout */}
        <TouchableOpacity style={styles.accountRow} onPress={handleLogout} activeOpacity={0.7}>
          <LogOut size={18} color="#ccc" />
          <Text style={styles.accountRowText}>{t("auth.logout")}</Text>
        </TouchableOpacity>

        {/* Delete account */}
        <TouchableOpacity style={styles.accountRow} onPress={handleDeleteAccount} activeOpacity={0.7}>
          <Trash2 size={18} color="#8b3a3a" />
          <Text style={[styles.accountRowText, styles.accountRowDanger]}>{t("auth.deleteAccount")}</Text>
        </TouchableOpacity>
      </View>

      {/* ── Usage quota card ─────────────────────────────────────────────────── */}
      <View style={styles.quotaCard}>
        {/* 헤더 */}
        <View style={styles.quotaHeader}>
          <Text style={styles.sectionTitle}>
            {t('settings.usageQuota')}
          </Text>
          <View style={[
            styles.quotaTierBadge,
            planTier === 'pro'      ? styles.quotaTierPro
            : planTier === 'standard' ? styles.quotaTierStandard
            : styles.quotaTierFree,
          ]}>
            <Text style={[
              styles.quotaTierText,
              planTier === 'pro'      ? styles.quotaTierTextPro
              : planTier === 'standard' ? styles.quotaTierTextStandard
              : styles.quotaTierTextFree,
            ]}>
              {planTier.toUpperCase()}
            </Text>
          </View>
        </View>

        {/* 숫자 요약 */}
        <View style={styles.quotaNumRow}>
          <View style={styles.quotaNumBox}>
            <Text style={styles.quotaNumLabel}>
              {t('settings.used', { defaultValue: '사용' })}
            </Text>
            <Text style={styles.quotaNumValue}>
              {usedMinutes >= 60
                ? `${Math.floor(usedMinutes / 60)}h ${Math.round(usedMinutes % 60)}m`
                : `${Math.round(usedMinutes * 10) / 10}m`}
            </Text>
          </View>

          <View style={styles.quotaNumDivider} />

          <View style={styles.quotaNumBox}>
            <Text style={styles.quotaNumLabel}>
              {isFree
                ? t('settings.dailyCap', { defaultValue: '일일 한도' })
                : t('settings.monthlyCap', { defaultValue: '월 한도' })}
            </Text>
            <Text style={styles.quotaNumValue}>
              {capMinutes > 0
                ? capMinutes >= 60
                  ? `${Math.floor(capMinutes / 60)}h`
                  : `${capMinutes}m`
                : '∞'}
            </Text>
          </View>

          <View style={styles.quotaNumDivider} />

          <View style={styles.quotaNumBox}>
            <Text style={styles.quotaNumLabel}>
              {t('settings.remaining', { defaultValue: '남음' })}
            </Text>
            <Text style={[
              styles.quotaNumValue,
              fillRatio >= 0.9 ? styles.quotaValueDanger
              : fillRatio >= 0.7 ? styles.quotaValueWarn
              : styles.quotaValueOk,
            ]}>
              {remainingLabel}
            </Text>
          </View>
        </View>

        {/* 프로그레스 바 */}
        {capMinutes > 0 && (
          <View style={styles.quotaBarTrack}>
            <View
              style={[
                styles.quotaBarFill,
                { width: `${Math.round(fillRatio * 100)}%` as any, backgroundColor: barColor },
              ]}
            />
          </View>
        )}

        {/* 퍼센트 + 리셋 날짜 */}
        <View style={styles.quotaFooter}>
          {capMinutes > 0 && (
            <Text style={[styles.quotaFooterText, { color: barColor }]}>
              {Math.round(fillRatio * 100)}%{' '}
              {t('settings.quotaUsed', { defaultValue: '사용됨' })}
            </Text>
          )}
          {resetLabel && (
            <Text style={styles.quotaResetText}>
              {isFree
                ? t('settings.resetsDaily', { defaultValue: '매일 자정 초기화' })
                : `${t('settings.resetsOn', { defaultValue: '초기화' })} ${resetLabel}`}
            </Text>
          )}
          {!resetLabel && isFree && (
            <Text style={styles.quotaResetText}>
              {t('settings.resetsDaily', { defaultValue: '매일 자정 초기화' })}
            </Text>
          )}
        </View>
      </View>

      {/* ── Interface language ──────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("settings.languageSection")}</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{t("settings.displayLanguage")}</Text>
          <TouchableOpacity
            style={styles.dropdown}
            onPress={() => setLangDropdownVisible(true)}
          >
            <Text style={styles.dropdownText}>
              {LANGUAGES.find((l) => l.code === settings.interfaceLanguage)?.nativeName ?? "한국어"}
            </Text>
            <Text style={styles.dropdownArrow}>▾</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Model management ────────────────────────────────────────────────── */}
      <TouchableOpacity
        style={styles.modelManageBtn}
        onPress={() => router.push("/models")}
        activeOpacity={0.8}
      >
        <Text style={styles.modelManageBtnText}>{t("home.modelManage")}</Text>
      </TouchableOpacity>

      {/* ── Subtitle appearance ──────────────────────────────────────────────── */}
      <Section title={t("settings.subtitleStyleSection")}>

        <Text style={styles.subLabel}>{t("settings.subtitleDesign")}</Text>
        <View style={styles.styleCardRow}>
          {subtitleStyles.map((s) => {
            const isActive = settings.subtitleStyle === s.key;
            return (
              <TouchableOpacity
                key={s.key}
                style={[styles.styleCard, isActive && styles.styleCardActive]}
                onPress={() => update({ subtitleStyle: s.key })}
                activeOpacity={0.75}
              >
                <View style={styles.stylePreview}>
                  {s.key === "outline" && (
                    <Text style={styles.previewOutline}>Sub</Text>
                  )}
                  {s.key === "pill" && (
                    <View style={styles.previewPillBox}>
                      <Text style={styles.previewPillText}>Sub</Text>
                    </View>
                  )}
                  {s.key === "bar" && (
                    <View style={styles.previewBarBox}>
                      <Text style={styles.previewBarText}>Sub</Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.styleCardLabel, isActive && styles.styleCardLabelActive]}>
                  {s.label}
                </Text>
                <Text style={styles.styleCardDesc}>{s.desc}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Row label={t("settings.fontSize", { size: settings.subtitleFontSize })}>
          <Slider
            style={{ flex: 1 }}
            minimumValue={10}
            maximumValue={25}
            step={1}
            value={settings.subtitleFontSize}
            onValueChange={(v) => update({ subtitleFontSize: v })}
            minimumTrackTintColor="#2a3f6f"
            maximumTrackTintColor="#333"
          />
        </Row>

        <Row label={t("settings.opacity", { pct: Math.round(settings.subtitleOpacity * 100) })}>
          <Slider
            style={{ flex: 1 }}
            minimumValue={0.3}
            maximumValue={1.0}
            step={0.05}
            value={settings.subtitleOpacity}
            onValueChange={(v) => update({ subtitleOpacity: v })}
            minimumTrackTintColor="#2a3f6f"
            maximumTrackTintColor="#333"
          />
        </Row>

        <View style={{ gap: 6 }}>
          <Text style={styles.subLabel}>{t("settings.subtitleMode")}</Text>
          {(["both", "translation", "original"] as const).map((mode) => (
            <TouchableOpacity
              key={mode}
              style={[styles.modeBtn, settings.subtitleMode === mode && styles.modeBtnActive]}
              onPress={() => update({ subtitleMode: mode })}
            >
              <Text style={[styles.modeBtnText, settings.subtitleMode === mode && styles.modeBtnTextActive]}>
                {mode === "both" ? t("settings.both") : mode === "translation" ? t("settings.translationOnly") : t("settings.originalOnly")}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </Section>

      {/* ── Timing offset ────────────────────────────────────────────────────── */}
      <Section title={t("settings.timingOffset", { offset: settings.timingOffset })}>
        <Slider
          minimumValue={-5}
          maximumValue={5}
          step={0.1}
          value={settings.timingOffset}
          onValueChange={(v) => update({ timingOffset: Math.round(v * 10) / 10 })}
          minimumTrackTintColor="#2a3f6f"
          maximumTrackTintColor="#333"
        />
        <Text style={styles.hint}>{t("settings.timingOffsetHint")}</Text>
      </Section>

      {/* ── Support ─────────────────────────────────────────────────────────── */}
      <TouchableOpacity
        style={styles.supportBtn}
        onPress={() => router.push('/about')}
        activeOpacity={0.8}
      >
        <Text style={[styles.supportBtnText, { color: '#ccc' }]}>앱 정보</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.supportBtn}
        onPress={() => router.push("/support")}
        activeOpacity={0.8}
      >
        <Text style={styles.supportBtnText}>{t("support.settingsBtn")}</Text>
      </TouchableOpacity>

      {/* ── Password change modal ──────────────────────────────────────────── */}
      <Modal
        visible={pwModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPwModalVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setPwModalVisible(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>{t("auth.changePassword")}</Text>
            <View style={styles.pwWrapper}>
              <TextInput
                style={[styles.pwInput, styles.pwInputInner]}
                value={currentPw}
                onChangeText={setCurrentPw}
                placeholder={t("auth.currentPassword")}
                placeholderTextColor="#555"
                secureTextEntry={!showCurrentPw}
                selectionColor="#2a3f6f"
              />
              <TouchableOpacity style={styles.pwEyeBtn} onPress={() => setShowCurrentPw(v => !v)}>
                {showCurrentPw ? <Eye size={18} color="#555" /> : <EyeOff size={18} color="#555" />}
              </TouchableOpacity>
            </View>
            <View style={styles.pwWrapper}>
              <TextInput
                style={[styles.pwInput, styles.pwInputInner]}
                value={newPw}
                onChangeText={setNewPw}
                placeholder={t("auth.newPassword")}
                placeholderTextColor="#555"
                secureTextEntry={!showNewPw}
                selectionColor="#2a3f6f"
              />
              <TouchableOpacity style={styles.pwEyeBtn} onPress={() => setShowNewPw(v => !v)}>
                {showNewPw ? <Eye size={18} color="#555" /> : <EyeOff size={18} color="#555" />}
              </TouchableOpacity>
            </View>
            <View style={styles.pwWrapper}>
              <TextInput
                style={[styles.pwInput, styles.pwInputInner]}
                value={confirmPw}
                onChangeText={setConfirmPw}
                placeholder={t("auth.passwordConfirm")}
                placeholderTextColor="#555"
                secureTextEntry={!showConfirmPw}
                selectionColor="#2a3f6f"
              />
              <TouchableOpacity style={styles.pwEyeBtn} onPress={() => setShowConfirmPw(v => !v)}>
                {showConfirmPw ? <Eye size={18} color="#555" /> : <EyeOff size={18} color="#555" />}
              </TouchableOpacity>
            </View>
            {!!pwError   && <Text style={styles.pwError}>{pwError}</Text>}
            {!!pwSuccess && <Text style={styles.pwSuccess}>{pwSuccess}</Text>}
            <View style={styles.pwBtnRow}>
              <TouchableOpacity
                style={styles.pwCancelBtn}
                onPress={() => setPwModalVisible(false)}
              >
                <Text style={styles.pwCancelText}>{t("common.cancel")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pwSaveBtn, pwLoading && { opacity: 0.6 }]}
                onPress={handleChangePassword}
                disabled={pwLoading}
              >
                {pwLoading
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.pwSaveText}>{t("auth.saveChanges")}</Text>
                }
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={langDropdownVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLangDropdownVisible(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setLangDropdownVisible(false)}
        >
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>{t("settings.selectDisplayLanguage")}</Text>
            <ScrollView style={{ maxHeight: 360 }} nestedScrollEnabled>
              {LANGUAGES.map((lang) => {
                const isActive = settings.interfaceLanguage === lang.code;
                return (
                  <TouchableOpacity
                    key={lang.code}
                    style={[styles.modalOption, isActive && styles.modalOptionActive]}
                    onPress={() => {
                      update({ interfaceLanguage: lang.code });
                      setLangDropdownVisible(false);
                    }}
                  >
                    <Text style={styles.modalOptionText}>{lang.nativeName}</Text>
                    <Text style={styles.modalOptionSub}>{lang.name}</Text>
                    {isActive && <Check size={14} color="#2a3f6f" />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* [DEV] Developer Test Mode Panel */}
      <DevModePanel />

    </ScrollView>
  );
}

// ── Layout helpers ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {children}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content:   { padding: 16, gap: 8, paddingBottom: 40 },

  section: {
    backgroundColor: "#141414",
    borderRadius: 12,
    padding: 16,
    gap: 4,
    marginBottom: 12,
  },
  sectionTitle: {
    color: "#888",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  subLabel: {
    color: "#888",
    fontSize: 12,
    fontWeight: "600",
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 36,
  },
  rowLabel: { color: "#ccc", fontSize: 14, minWidth: 100, flexShrink: 1 },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: "#222",
  },
  chipActive:     { backgroundColor: "#2a3f6f" },
  chipText:       { color: "#aaa", fontSize: 13 },
  chipTextActive: { color: "#fff", fontWeight: "600" },

  styleCardRow: { flexDirection: "row", gap: 8 },
  styleCard: {
    flex: 1,
    backgroundColor: "#1a1a1a",
    borderRadius: 10,
    padding: 10,
    alignItems: "center",
    gap: 6,
    borderWidth: 1.5,
    borderColor: "#2a2a2a",
  },
  styleCardActive: { borderColor: "#2a3f6f", backgroundColor: "#0d1a2e" },
  stylePreview: {
    width: "100%",
    height: 40,
    backgroundColor: "#333",
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  previewOutline: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "800",
    textShadowColor: "rgba(0,0,0,1)",
    textShadowOffset: { width: 2, height: 2 },
    textShadowRadius: 4,
  },
  previewPillBox: {
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  previewPillText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  previewBarBox: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.75)",
    paddingVertical: 4,
    alignItems: "center",
  },
  previewBarText: { color: "#fff", fontSize: 13, fontWeight: "700" },

  styleCardLabel:       { color: "#aaa", fontSize: 12, fontWeight: "600" },
  styleCardLabelActive: { color: "#5a82b0" },
  styleCardDesc:        { color: "#555", fontSize: 10, textAlign: "center" },

  dropdown: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#222",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 8,
    borderWidth: 1,
    borderColor: "#333",
  },
  dropdownText:  { color: "#fff", fontSize: 13, fontWeight: "600" },
  dropdownArrow: { color: "#666", fontSize: 12 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  modalCard: {
    backgroundColor: "#1a1a1a",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#2a2a2a",
  },
  modalTitle: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 12,
  },
  modalOption: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2a2a2a",
    gap: 8,
  },
  modalOptionActive: { backgroundColor: "#162540", borderRadius: 8 },
  modalOptionText:   { color: "#fff", fontSize: 15, flex: 1 },
  modalOptionSub:    { color: "#555", fontSize: 12 },

  supportBtn: {
    backgroundColor: "#141414",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#2a2a2a",
    marginBottom: 12,
  },
  supportBtnText: { color: "#5a82b0", fontSize: 15, fontWeight: "600" },

  modelManageBtn: {
    backgroundColor: "#141414",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#2a2a2a",
    marginBottom: 12,
  },
  modelManageBtnText: { color: "#ccc", fontSize: 14, fontWeight: "600" },

  modeBtn:          { backgroundColor: "#222", borderRadius: 10, paddingVertical: 8, paddingHorizontal: 16, alignItems: "center" },
  modeBtnActive:    { backgroundColor: "#2a3f6f" },
  modeBtnText:      { color: "#aaa", fontSize: 14 },
  modeBtnTextActive:{ color: "#fff", fontWeight: "600" },

  hint:     { color: "#555", fontSize: 11, marginTop: 2 },
  hintOk:   { color: "#2d7a5e" },
  hintWarn: { color: "#b07d2a" },

  infoText: { color: "#4b5563", fontSize: 12, textAlign: "center", marginTop: 4 },

  // ── Account card ─────────────────────────────────────────────────────────
  accountCard: {
    backgroundColor: "#141414",
    borderRadius: 12,
    padding: 16,
    gap: 0,
    marginBottom: 12,
  },
  accountProfileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 10,
    marginBottom: 12,
  },
  accountAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#2a3f6f",
    alignItems: "center",
    justifyContent: "center",
  },
  accountAvatarText: { color: "#fff", fontSize: 20, fontWeight: "700" },
  accountName:       { color: "#fff", fontSize: 14, fontWeight: "600", marginBottom: 5 },

  planBadge:         { alignSelf: "flex-start", borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  planBadgeFree:     { backgroundColor: "#1a1a1a", borderColor: "#333" },
  planBadgePro:      { backgroundColor: "#0f2318", borderColor: "#2d7a5e" },
  planBadgeText:     { fontSize: 11, fontWeight: "600" },
  planBadgeTextFree: { color: "#888" },
  planBadgeTextPro:  { color: "#2d7a5e" },

  googleBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#1a1a1a",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#333",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  googleBadgeText:  { color: "#ea4335", fontSize: 13, fontWeight: "700" },
  googleBadgeLabel: { color: "#888", fontSize: 11 },

  accountDivider: { height: StyleSheet.hairlineWidth, backgroundColor: "#2a2a2a", marginVertical: 4 },

  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 13,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1f1f1f",
  },
  accountRowText:    { flex: 1, color: "#ccc", fontSize: 14 },
  accountRowChevron: { color: "#555", fontSize: 18 },
  accountRowDanger:  { color: "#8b3a3a" },

  // ── Password modal ────────────────────────────────────────────────────────
  pwWrapper:    { position: "relative", marginBottom: 10 },
  pwInputInner: { marginBottom: 0, paddingRight: 44 },
  pwEyeBtn:     { position: "absolute", right: 14, top: 0, bottom: 0, justifyContent: "center", padding: 4 },
  pwInput: {
    backgroundColor: "#111",
    borderWidth: 1,
    borderColor: "#2a2a2a",
    borderRadius: 10,
    color: "#fff",
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 14,
    marginBottom: 10,
  },
  pwError:   { color: "#8b3a3a", fontSize: 12, marginBottom: 8 },
  pwSuccess: { color: "#2d7a5e", fontSize: 12, marginBottom: 8 },
  pwBtnRow:  { flexDirection: "row", gap: 10, marginTop: 4 },
  pwCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#222",
    alignItems: "center",
  },
  pwCancelText: { color: "#888", fontSize: 14, fontWeight: "600" },
  pwSaveBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#2a3f6f",
    alignItems: "center",
  },
  pwSaveText: { color: "#fff", fontSize: 14, fontWeight: "700" },

  // ── Quota card ────────────────────────────────────────────────────────────
  quotaCard: {
    backgroundColor: "#141414",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    gap: 12,
  },
  quotaHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  quotaTierBadge: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  quotaTierFree:     { backgroundColor: "#1a1a1a",  borderColor: "#333" },
  quotaTierStandard: { backgroundColor: "#111d2e",  borderColor: "#2a3f6f" },
  quotaTierPro:      { backgroundColor: "#0f2318",  borderColor: "#2d7a5e" },
  quotaTierText:     { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  quotaTierTextFree:     { color: "#666" },
  quotaTierTextStandard: { color: "#5a82b0" },
  quotaTierTextPro:      { color: "#2d7a5e" },

  quotaNumRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1a1a1a",
    borderRadius: 10,
    overflow: "hidden",
  },
  quotaNumBox: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    gap: 3,
  },
  quotaNumDivider: {
    width: StyleSheet.hairlineWidth,
    height: 32,
    backgroundColor: "#2a2a2a",
  },
  quotaNumLabel: {
    color: "#555",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  quotaNumValue: {
    color: "#e0e0e0",
    fontSize: 15,
    fontWeight: "700",
  },
  quotaValueOk:     { color: "#5a82b0" },
  quotaValueWarn:   { color: "#b07d2a" },
  quotaValueDanger: { color: "#8b3a3a" },

  quotaBarTrack: {
    height: 5,
    backgroundColor: "#222",
    borderRadius: 3,
    overflow: "hidden",
  },
  quotaBarFill: {
    height: 5,
    borderRadius: 3,
  },

  quotaFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: -4,
  },
  quotaFooterText: {
    fontSize: 11,
    fontWeight: "600",
  },
  quotaResetText: {
    color: "#444",
    fontSize: 11,
  },
});