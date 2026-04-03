import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  FlatList,
  StyleSheet,
} from "react-native";
import { LANGUAGES, SOURCE_LANGUAGES, Language } from "../constants/languages";

interface LanguageSelectorProps {
  value: string;
  onChange: (code: string) => void;
  includeAuto?: boolean;
  label?: string;
}

export function LanguageSelector({
  value,
  onChange,
  includeAuto = false,
  label,
}: LanguageSelectorProps) {
  const [open, setOpen] = useState(false);
  const list = includeAuto ? SOURCE_LANGUAGES : LANGUAGES;
  const selected = list.find((l) => l.code === value);

  return (
    <View>
      {label && <Text style={styles.label}>{label}</Text>}
      <TouchableOpacity style={styles.button} onPress={() => setOpen(true)}>
        <Text style={styles.buttonText}>
          {selected ? `${selected.nativeName} (${selected.code})` : value}
        </Text>
        <Text style={styles.chevron}>▼</Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade">
        <TouchableOpacity
          style={styles.backdrop}
          onPress={() => setOpen(false)}
        >
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>언어 선택</Text>
            <FlatList
              data={list}
              keyExtractor={(item) => item.code}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[
                    styles.option,
                    item.code === value && styles.optionSelected,
                  ]}
                  onPress={() => {
                    onChange(item.code);
                    setOpen(false);
                  }}
                >
                  <Text style={styles.optionText}>{item.nativeName}</Text>
                  <Text style={styles.optionCode}>{item.code}</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: "#aaa", fontSize: 12, marginBottom: 4 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1e1e1e",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  buttonText: { color: "#fff", fontSize: 15 },
  chevron: { color: "#aaa", fontSize: 12 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#1a1a1a",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: "60%",
    paddingTop: 16,
  },
  sheetTitle: {
    color: "#fff",
    fontWeight: "bold",
    fontSize: 16,
    textAlign: "center",
    marginBottom: 8,
  },
  option: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#333",
  },
  optionSelected: { backgroundColor: "#2a2a2a" },
  optionText: { color: "#fff", fontSize: 15 },
  optionCode: { color: "#888", fontSize: 13 },
});
