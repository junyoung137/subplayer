import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  SafeAreaView,
} from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import emailjs from "@emailjs/react-native";

const EMAILJS_SERVICE_ID  = "service_wijk1tx";
const EMAILJS_TEMPLATE_ID = "template_6iewdvl";
const EMAILJS_PUBLIC_KEY  = "eK0w68XYEX0zYUo5X";

type InquiryType = "bug" | "feature" | "translationError" | "other";

export default function SupportScreen() {
  const { t } = useTranslation();

  const [inquiryType, setInquiryType] = useState<InquiryType>("bug");
  const [email,       setEmail]       = useState("");
  const [title,       setTitle]       = useState("");
  const [message,     setMessage]     = useState("");
  const [isSending,   setIsSending]   = useState(false);

  const chips: { key: InquiryType; label: string }[] = [
    { key: "bug",              label: t("support.bug")              },
    { key: "feature",          label: t("support.feature")          },
    { key: "translationError", label: t("support.translationError") },
    { key: "other",            label: t("support.other")            },
  ];

  const canSend = title.trim().length > 0 && message.trim().length > 0;

  const handleSend = async () => {
    if (!canSend || isSending) return;
    setIsSending(true);
    try {
      await emailjs.send(
        EMAILJS_SERVICE_ID,
        EMAILJS_TEMPLATE_ID,
        {
          inquiry_type: t(`support.${inquiryType}`),
          title:        title.trim(),
          user_email:   email.trim() || "(no email provided)",
          message:      message.trim(),
        },
        { publicKey: EMAILJS_PUBLIC_KEY },
      );
      Alert.alert(t("support.successTitle"), t("support.successMsg"), [
        { text: t("common.confirm"), onPress: () => router.back() },
      ]);
    } catch {
      Alert.alert(t("support.errorTitle"), t("support.errorMsg"));
    } finally {
      setIsSending(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
          <Text style={styles.closeBtnText}>✕</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("support.title")}</Text>
        <View style={styles.closeBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Inquiry type chips */}
        <Text style={styles.label}>{t("support.inquiryType")}</Text>
        <View style={styles.chipRow}>
          {chips.map((chip) => (
            <TouchableOpacity
              key={chip.key}
              style={[styles.chip, inquiryType === chip.key && styles.chipActive]}
              onPress={() => setInquiryType(chip.key)}
            >
              <Text style={[styles.chipText, inquiryType === chip.key && styles.chipTextActive]}>
                {chip.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Email input */}
        <Text style={styles.label}>{t("support.emailLabel")}</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder={t("support.emailPlaceholder")}
          placeholderTextColor="#444"
          selectionColor="#2563eb"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="next"
        />

        {/* Title input */}
        <Text style={styles.label}>{t("support.titleLabel")}</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder={t("support.titlePlaceholder")}
          placeholderTextColor="#444"
          selectionColor="#2563eb"
          returnKeyType="next"
          maxLength={200}
        />

        {/* Message input */}
        <View style={styles.messageWrap}>
          <Text style={styles.label}>{t("support.messageLabel")}</Text>
          <TextInput
            style={styles.messageInput}
            value={message}
            onChangeText={(v) => setMessage(v.slice(0, 5000))}
            placeholder={t("support.messagePlaceholder")}
            placeholderTextColor="#444"
            selectionColor="#2563eb"
            multiline
            textAlignVertical="top"
          />
          <Text style={styles.charCount}>{message.length} / 5000</Text>
        </View>

        {/* Send button */}
        <TouchableOpacity
          style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!canSend || isSending}
          activeOpacity={0.8}
        >
          {isSending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.sendBtnText}>{t("support.send")}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },

  // ── Header ───────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#222",
  },
  closeBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  closeBtnText: { color: "#fff", fontSize: 18 },
  headerTitle:  { color: "#fff", fontSize: 17, fontWeight: "700" },

  // ── Scroll content ────────────────────────────────────────────────────────────
  scroll:  { flex: 1 },
  content: { padding: 20, gap: 12, paddingBottom: 40 },

  label: {
    color: "#888",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 4,
  },

  // ── Chips ─────────────────────────────────────────────────────────────────────
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "#1a1a1a",
    borderWidth: 1,
    borderColor: "#2a2a2a",
  },
  chipActive:     { backgroundColor: "#2563eb", borderColor: "#2563eb" },
  chipText:       { color: "#888", fontSize: 13, fontWeight: "500" },
  chipTextActive: { color: "#fff", fontWeight: "600" },

  // ── Text inputs ───────────────────────────────────────────────────────────────
  input: {
    backgroundColor: "#141414",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2a2a2a",
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#fff",
    fontSize: 14,
    marginBottom: 8,
  },

  messageWrap: { gap: 4 },
  messageInput: {
    backgroundColor: "#141414",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2a2a2a",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 36,
    color: "#fff",
    fontSize: 14,
    minHeight: 180,
  },
  charCount: {
    color: "#444",
    fontSize: 11,
    textAlign: "right",
    marginTop: 4,
  },

  // ── Send button ───────────────────────────────────────────────────────────────
  sendBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
  },
  sendBtnDisabled: { opacity: 0.35 },
  sendBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
