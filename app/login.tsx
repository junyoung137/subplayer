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
import { signInWithEmail, signInWithGoogle } from "../services/authService";
import { Eye, EyeOff } from 'lucide-react-native';
import { auth } from "../services/firebase";

function mapFirebaseError(code: string, t: (k: string) => string): string {
  switch (code) {
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-credential":
      return t("auth.errorWrongCredentials");
    case "auth/network-request-failed":
      return t("auth.errorNetwork");
    default:
      return t("auth.errorDefault");
  }
}

export default function LoginScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [email,            setEmail]            = useState("");
  const [password,         setPassword]         = useState("");
  const [error,            setError]            = useState("");
  const [success,          setSuccess]          = useState("");
  const [isLoadingEmail,   setIsLoadingEmail]   = useState(false);
  const [isLoadingGoogle,  setIsLoadingGoogle]  = useState(false);
  const [showPassword,     setShowPassword]     = useState(false);

  const handleForgotPassword = async () => {
    setError("");
    setSuccess("");
    if (!email.trim()) {
      setError(t("auth.errorEmailRequired"));
      return;
    }
    try {
      await auth().sendPasswordResetEmail(email.trim());
      setSuccess(t("auth.resetEmailSent"));
    } catch (e: any) {
      setError(mapFirebaseError(e?.code ?? "", t));
    }
  };

  const handleEmailLogin = async () => {
    setError("");
    setSuccess("");
    setIsLoadingEmail(true);
    try {
      await signInWithEmail(email.trim(), password);
      router.replace("/");
    } catch (e: any) {
      setError(mapFirebaseError(e?.code ?? "", t));
    } finally {
      setIsLoadingEmail(false);
    }
  };

  const handleGoogleLogin = async () => {
    setError("");
    setIsLoadingGoogle(true);
    try {
      await signInWithGoogle();
      router.replace("/");
    } catch (e: any) {
      setError(mapFirebaseError(e?.code ?? "", t));
    } finally {
      setIsLoadingGoogle(false);
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
        {/* App name */}
        <View style={styles.topSection}>
          <Text style={styles.appName}>RealtimeSub</Text>
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
          <TouchableOpacity onPress={handleForgotPassword}>
            <Text style={styles.forgotText}>{t("auth.forgotPassword")}</Text>
          </TouchableOpacity>
        </View>

        {/* Error / Success */}
        {!!error   && <Text style={styles.errorText}>{error}</Text>}
        {!!success && <Text style={styles.successText}>{success}</Text>}

        {/* Email login button */}
        <TouchableOpacity
          style={[styles.primaryBtn, isLoadingEmail && styles.btnDisabled]}
          onPress={handleEmailLogin}
          disabled={isLoadingEmail || isLoadingGoogle}
          activeOpacity={0.8}
        >
          {isLoadingEmail ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>{t("auth.login")}</Text>
          )}
        </TouchableOpacity>

        {/* Divider */}
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>{t("auth.or")}</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* Google button */}
        <TouchableOpacity
          style={[styles.googleBtn, isLoadingGoogle && styles.btnDisabled]}
          onPress={handleGoogleLogin}
          disabled={isLoadingEmail || isLoadingGoogle}
          activeOpacity={0.8}
        >
          {isLoadingGoogle ? (
            <ActivityIndicator color="#ccc" />
          ) : (
            <>
              <Text style={styles.googleG}>G</Text>
              <Text style={styles.googleBtnText}>{t("auth.loginWithGoogle")}</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Sign up link */}
        <View style={styles.bottomRow}>
          <Text style={styles.bottomText}>{t("auth.noAccount")} </Text>
          <TouchableOpacity onPress={() => router.push("./signup")}>
            <Text style={styles.bottomLink}>{t("auth.signUp")}</Text>
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
    marginBottom: 48,
  },
  appName: {
    fontSize: 32,
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

  errorText: {
    color: "#ef4444",
    fontSize: 13,
    marginBottom: 12,
    marginTop: -4,
  },
  passwordWrapper: { position: "relative", marginBottom: 12 },
  passwordInput:   { marginBottom: 0, paddingRight: 44 },
  eyeBtn: { position: "absolute", right: 14, top: 0, bottom: 0, justifyContent: "center", padding: 4 },
  forgotText: {
    color: "#2563eb",
    fontSize: 13,
    textAlign: "right",
    marginBottom: 8,
    marginTop: -4,
  },
  successText: {
    color: "#22c55e",
    fontSize: 13,
    marginBottom: 12,
  },

  primaryBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
    marginBottom: 20,
  },
  btnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 20,
    gap: 10,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#2a2a2a" },
  dividerText: { color: "#555", fontSize: 13 },

  googleBtn: {
    backgroundColor: "#1a1a1a",
    borderWidth: 1,
    borderColor: "#333",
    borderRadius: 12,
    paddingVertical: 15,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 32,
    gap: 10,
  },
  googleG: { color: "#ea4335", fontSize: 18, fontWeight: "700" },
  googleBtnText: { color: "#ccc", fontSize: 15, fontWeight: "600" },

  bottomRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
  },
  bottomText: { color: "#666", fontSize: 14 },
  bottomLink: { color: "#2563eb", fontSize: 14, fontWeight: "600" },
});
