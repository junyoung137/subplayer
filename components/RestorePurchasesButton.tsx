import React from "react";
import {
  TouchableOpacity,
  Text,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from "react-native";
import { usePurchaseStore, usePurchaseLoading } from "../store/usePurchaseStore";

interface Props {
  label?: string;
  noRestoreLabel?: string;
}

export function RestorePurchasesButton({
  label = "Restore Purchases",
  noRestoreLabel = "No purchases found to restore.",
}: Props) {
  const isLoading = usePurchaseLoading();

  const handleRestore = async () => {
    const store = usePurchaseStore.getState();
    await store.restorePurchases();

    const { error } = usePurchaseStore.getState();
    if (error === "NO_ACTIVE_PURCHASES") {
      Alert.alert("Restore", noRestoreLabel);
      store.clearError();
    } else if (error) {
      Alert.alert("Restore Failed", error);
      store.clearError();
    } else {
      Alert.alert("Restored", "Your purchases have been restored successfully.");
    }
  };

  return (
    <TouchableOpacity
      style={styles.btn}
      onPress={handleRestore}
      disabled={isLoading}
    >
      {isLoading
        ? <ActivityIndicator size="small" color="#888" />
        : <Text style={styles.text}>{label}</Text>
      }
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: { paddingVertical: 12, paddingHorizontal: 24, alignItems: "center" },
  text: { color: "#888", fontSize: 13, textDecorationLine: "underline" },
});
