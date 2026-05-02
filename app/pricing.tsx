import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { ChevronLeft, Check } from "lucide-react-native";
import { useCurrentPlan } from "../store/usePlanStore";

type PlanId = "free" | "standard" | "pro";

interface Plan {
  id: PlanId;
  labelKey: string;
  price: string;
  hidePeriod?: boolean;
  features: string[];
}

export default function PricingScreen() {
  const { t } = useTranslation();
  const currentPlan = useCurrentPlan();

  const plans: Plan[] = [
    {
      id: "free",
      labelKey: "Free",
      price: "$0",
      hidePeriod: true,
      features: [
        t("pricing.freeF1"),
        t("pricing.freeF2"),
      ],
    },
    {
      id: "standard",
      labelKey: "Standard",
      price: "$7.99",
      features: [
        t("pricing.stdF1"),
        t("pricing.stdF2"),
      ],
    },
    {
      id: "pro",
      labelKey: "Pro",
      price: "$13.99",
      features: [
        t("pricing.proF1"),
        t("pricing.proF2"),
      ],
    },
  ];

  const handleSelect = (plan: Plan) => {
    if (plan.id === "free") return;
    Alert.alert(plan.labelKey, t("pricing.comingSoon"));
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <ChevronLeft size={22} color="#aaa" />
        </TouchableOpacity>
        <Text style={styles.title}>{t("pricing.title")}</Text>
        <View style={styles.backBtn} />
      </View>

      <Text style={styles.subtitle}>{t("pricing.subtitle")}</Text>

      {/* Plan cards */}
      {plans.map((plan) => {
        const isActive = currentPlan === plan.id;
        return (
          <View
            key={plan.id}
            style={[
              styles.card,
              isActive && plan.id === "free"      && styles.cardActiveFree,
              isActive && plan.id === "standard"  && styles.cardActiveStandard,
              isActive && plan.id === "pro"       && styles.cardActivePro,
            ]}
          >
            <View style={styles.cardTop}>
              <Text style={styles.planName}>{plan.labelKey}</Text>
              <Text style={styles.planPrice}>
                {plan.price}
                {!plan.hidePeriod && <Text style={styles.planPeriod}>/mo</Text>}
              </Text>
            </View>

            <View style={styles.featureList}>
              {plan.features.map((f, i) => (
                <View key={i} style={styles.featureRow}>
                  <Check
                    size={14}
                    color={
                      !isActive ? "#555"
                      : plan.id === "free"     ? "#2d7a5e"
                      : plan.id === "standard" ? "#5a82b0"
                      : "#9a7a3a"
                    }
                  />
                  <Text style={styles.featureText}>{f}</Text>
                </View>
              ))}
            </View>

            <TouchableOpacity
              style={[
                styles.actionBtn,
                isActive && plan.id === "free"      && styles.actionBtnActiveFree,
                isActive && plan.id === "standard"  && styles.actionBtnActiveStandard,
                isActive && plan.id === "pro"       && styles.actionBtnActivePro,
              ]}
              onPress={() => handleSelect(plan)}
              disabled={isActive}
            >
              <Text style={[styles.actionBtnText, isActive && plan.id === "free" && styles.actionBtnTextActiveFree, isActive && plan.id === "standard" && styles.actionBtnTextActiveStandard, isActive && plan.id === "pro" && styles.actionBtnTextActivePro]}>
                {isActive
                  ? t("pricing.currentPlan")
                  : plan.id === "free"
                  ? t("pricing.startFree")
                  : t("pricing.subscribe")}
              </Text>
            </TouchableOpacity>
          </View>
        );
      })}

      {/* Note */}
      <Text style={styles.note}>{t("pricing.note")}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { padding: 16, paddingBottom: 48, gap: 12 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  backBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  title: { color: "#fff", fontSize: 18, fontWeight: "700" },
  subtitle: { color: "#888", fontSize: 13, textAlign: "center", marginBottom: 8 },

  card: {
    backgroundColor: "#141414",
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: "#2a2a2a",
    gap: 14,
  },
  cardActiveFree:     { borderColor: "#2d7a5e", backgroundColor: "#0a1510" },
  cardActiveStandard: { borderColor: "#5a82b0", backgroundColor: "#0b1525" },
  cardActivePro:      { borderColor: "#9a7a3a", backgroundColor: "#141000" },

  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  planName: { color: "#fff", fontSize: 17, fontWeight: "700" },
  planPrice: { color: "#fff", fontSize: 22, fontWeight: "700" },
  planPeriod: { color: "#888", fontSize: 13, fontWeight: "400" },

  featureList: { gap: 8 },
  featureRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  featureText: { color: "#ccc", fontSize: 13, flex: 1, lineHeight: 18 },

  actionBtn: {
    backgroundColor: "#1e1e1e",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  actionBtnActiveFree:     { backgroundColor: "#0c1a12", borderWidth: 1, borderColor: "#2d7a5e" },
  actionBtnActiveStandard: { backgroundColor: "#0c1a30", borderWidth: 1, borderColor: "#5a82b0" },
  actionBtnActivePro:      { backgroundColor: "#181200", borderWidth: 1, borderColor: "#9a7a3a" },
  actionBtnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  actionBtnTextActiveFree:     { color: "#2d7a5e" },
  actionBtnTextActiveStandard: { color: "#5a82b0" },
  actionBtnTextActivePro:      { color: "#9a7a3a" },

  note: {
    color: "#555",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
    paddingHorizontal: 4,
  },
});
