import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { signUpWithEmail } from "../services/authService";
import { Eye, EyeOff } from 'lucide-react-native';

function mapFirebaseError(code: string, t: (k: string) => string): string {
  switch (code) {
    case "auth/email-already-in-use":
      return t("auth.errorEmailInUse");
    case "auth/network-request-failed":
      return t("auth.errorNetwork");
    default:
      return t("auth.errorDefault");
  }
}

export default function SignupScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [email,           setEmail]           = useState("");
  const [password,        setPassword]        = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error,           setError]           = useState("");
  const [isLoading,       setIsLoading]       = useState(false);
  const [showPassword,    setShowPassword]    = useState(false);
  const [showConfirmPw,   setShowConfirmPw]   = useState(false);

  const handleSignUp = async () => {
    setError("");

    if (password.length < 6) {
      setError(t("auth.errorPasswordShort"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("auth.errorPasswordMismatch"));
      return;
    }

    setIsLoading(true);
    try {
      await signUpWithEmail(email.trim(), password);
      router.replace("/");
    } catch (e: any) {
      setError(mapFirebaseError(e?.code ?? "", t));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.container,
          { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Title */}
        <View style={styles.topSection}>
          <Text style={styles.title}>{t("auth.signUp")}</Text>
        </View>

        {/* Inputs */}
        <View style={styles.inputSection}>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder={t("auth.email")}
            placeholderTextColor="#555"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            selectionColor="#2563eb"
          />
          <View style={styles.passwordWrapper}>
            <TextInput
              style={[styles.input, styles.passwordInput]}
              value={password}
              onChangeText={setPassword}
              placeholder={t("auth.password")}
              placeholderTextColor="#555"
              secureTextEntry={!showPassword}
              selectionColor="#2563eb"
            />
            <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowPassword(v => !v)}>
              {showPassword ? <Eye size={18} color="#555" /> : <EyeOff size={18} color="#555" />}
            </TouchableOpacity>
          </View>
          <View style={styles.passwordWrapper}>
            <TextInput
              style={[styles.input, styles.passwordInput]}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder={t("auth.passwordConfirm")}
              placeholderTextColor="#555"
              secureTextEntry={!showConfirmPw}
              selectionColor="#2563eb"
            />
            <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowConfirmPw(v => !v)}>
              {showConfirmPw ? <Eye size={18} color="#555" /> : <EyeOff size={18} color="#555" />}
            </TouchableOpacity>
          </View>
        </View>

        {/* Error */}
        {!!error && <Text style={styles.errorText}>{error}</Text>}

        {/* Sign up button */}
        <TouchableOpacity
          style={[styles.primaryBtn, isLoading && styles.btnDisabled]}
          onPress={handleSignUp}
          disabled={isLoading}
          activeOpacity={0.8}
        >
          {isLoading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>{t("auth.signUp")}</Text>
          )}
        </TouchableOpacity>

        {/* Login link */}
        <View style={styles.bottomRow}>
          <Text style={styles.bottomText}>{t("auth.hasAccount")} </Text>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={styles.bottomLink}>{t("auth.login")}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#0a0a0a" },

  container: {
    flexGrow: 1,
    paddingHorizontal: 24,
  },

  topSection: {
    alignItems: "center",
    marginBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#fff",
  },

  inputSection: {
    marginBottom: 4,
  },
  input: {
    backgroundColor: "#1a1a1a",
    borderWidth: 1,
    borderColor: "#2a2a2a",
    borderRadius: 12,
    color: "#fff",
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    marginBottom: 12,
  },

  passwordWrapper: { position: "relative", marginBottom: 12 },
  passwordInput:   { marginBottom: 0, paddingRight: 44 },
  eyeBtn: { position: "absolute", right: 14, top: 0, bottom: 0, justifyContent: "center", padding: 4 },
  errorText: {
    color: "#ef4444",
    fontSize: 13,
    marginBottom: 12,
    marginTop: -4,
  },

  primaryBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
    marginBottom: 32,
  },
  btnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  bottomRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
  },
  bottomText: { color: "#666", fontSize: 14 },
  bottomLink: { color: "#2563eb", fontSize: 14, fontWeight: "600" },
});
