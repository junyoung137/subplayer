import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
} from "react-native";
import { X, Check } from 'lucide-react-native';
import {
  downloadGemmaModel,
  getModelMeta,
  deleteGemmaModel,
  getLocalModelPath,
  verifyModelIntegrity,
  type ModelMeta,
  type DownloadProgress,
} from "../services/modelDownloadService";

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase =
  | "checking"        // reading AsyncStorage on mount
  | "idle_not_downloaded"
  | "idle_downloaded"
  | "resolving"       // resolveModelDownloadUrl (mirror check)
  | "downloading"
  | "error";

// ── Screen ────────────────────────────────────────────────────────────────────

export default function GemmaModelsScreen() {
  const [phase,    setPhase]    = useState<Phase>("checking");
  const [meta,     setMeta]     = useState<ModelMeta | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const cancelledRef = useRef(false);

  // Load persisted metadata on mount, verifying the file actually exists
  useEffect(() => {
    (async () => {
      const saved = await verifyModelIntegrity();
      if (saved) {
        setMeta(saved);
        setPhase("idle_downloaded");
      } else {
        setPhase("idle_not_downloaded");
      }
    })();
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleDownload = async () => {
    cancelledRef.current = false;
    setErrorMsg("");
    setProgress(null);
    setPhase("resolving");

    try {
      await downloadGemmaModel((p) => {
        if (cancelledRef.current) return;
        // First progress callback means download started
        setPhase((prev) => (prev === "resolving" ? "downloading" : prev));
        setProgress(p);
      });

      if (cancelledRef.current) return;

      const saved = await getModelMeta();
      setMeta(saved);
      setPhase("idle_downloaded");
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      const msg =
        e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.";
      setErrorMsg(msg);
      setPhase("error");
    }
  };

  const handleDelete = () => {
    Alert.alert(
      "모델 삭제",
      "Gemma 모델 파일을 삭제하시겠습니까? (~1.5 GB)\n번역 기능을 사용하려면 다시 다운로드해야 합니다.",
      [
        { text: "취소", style: "cancel" },
        {
          text: "삭제",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteGemmaModel();
              const remaining = await getLocalModelPath();
              if (remaining) {
                Alert.alert("삭제 실패", "모델 파일을 삭제하지 못했습니다. 저장 공간을 확인해 주세요.");
                return;
              }
              setMeta(null);
              setProgress(null);
              setPhase("idle_not_downloaded");
            } catch (e) {
              const msg = e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.";
              Alert.alert("삭제 실패", msg);
            }
          },
        },
      ]
    );
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    setPhase("idle_not_downloaded");
    setProgress(null);
  };

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const formatBytes = (bytes: number) => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(0)} MB`;
    return `${(bytes / 1e6).toFixed(0)} MB`;
  };

  const downloadedMB = progress
    ? (progress.bytesWritten / 1e6).toFixed(0)
    : "0";
  const totalMB = progress && progress.bytesTotal > 0
    ? (progress.bytesTotal / 1e6).toFixed(0)
    : "1,500";
  const pct = progress ? Math.round(progress.fraction * 100) : 0;

  const downloadedDate = meta
    ? new Date(meta.downloadedAt).toLocaleDateString("ko-KR")
    : "";

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* ── Model info card ─────────────────────────────────────────── */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.modelName}>Gemma 3n E2B</Text>
          <StatusBadge phase={phase} />
        </View>

        <InfoRow label="포맷"  value="Q4_K_M GGUF" />
        <InfoRow label="크기"  value="~1.5 GB" />
        <InfoRow label="RAM"   value="추론 시 약 2 GB 사용" />
        <InfoRow label="용도"  value="한국어 자막 번역 (완전 오프라인)" />
        {meta && (
          <>
            <InfoRow label="다운로드" value={downloadedDate} />
            <InfoRow label="파일 크기" value={`${formatBytes(meta.size)}`} />
          </>
        )}
      </View>

      {/* ── Checking state ──────────────────────────────────────────── */}
      {phase === "checking" && (
        <View style={styles.statusCard}>
          <ActivityIndicator color="#2563eb" />
          <Text style={styles.statusText}>확인 중…</Text>
        </View>
      )}

      {/* ── Resolving (mirror check) ────────────────────────────────── */}
      {phase === "resolving" && (
        <View style={styles.statusCard}>
          <ActivityIndicator color="#2563eb" />
          <Text style={styles.statusText}>미러 서버 확인 중…</Text>
          <Text style={styles.statusHint}>
            최적의 다운로드 서버를 선택하고 있습니다 (최대 3곳 시도)
          </Text>
          <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
            <Text style={styles.cancelBtnText}>취소</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Downloading ─────────────────────────────────────────────── */}
      {phase === "downloading" && (
        <View style={styles.statusCard}>
          <ActivityIndicator color="#2563eb" />
          <Text style={styles.statusText}>다운로드 중… {pct}%</Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${pct}%` as any }]} />
          </View>
          <Text style={styles.progressBytes}>
            {downloadedMB} MB / {totalMB} MB
          </Text>
          <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
            <Text style={styles.cancelBtnText}>취소</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Error ───────────────────────────────────────────────────── */}
      {phase === "error" && (
        <View style={[styles.statusCard, styles.errorCard]}>
          <X size={32} color="#ef4444" />
          <Text style={styles.errorTitle}>다운로드 실패</Text>
          <Text style={styles.errorMsg}>{errorMsg}</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={handleDownload}>
            <Text style={styles.primaryBtnText}>다시 시도</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Not downloaded — CTA ────────────────────────────────────── */}
      {phase === "idle_not_downloaded" && (
        <View style={styles.ctaCard}>
          <Text style={styles.ctaTitle}>모델을 다운로드해야 번역이 가능합니다</Text>
          <Text style={styles.ctaHint}>
            Wi-Fi 연결을 권장합니다. HuggingFace에서 약 1.5 GB를 내려받습니다.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={handleDownload}>
            <Text style={styles.primaryBtnText}>다운로드 시작</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Downloaded — success + delete ──────────────────────────── */}
      {phase === "idle_downloaded" && (
        <>
          <View style={[styles.statusCard, styles.successCard]}>
            <Check size={32} color="#22c55e" />
            <Text style={styles.successText}>모델이 준비되었습니다</Text>
            <Text style={styles.successHint}>
              파일 크기 검증 완료 ({meta ? formatBytes(meta.size) : ""})
            </Text>
          </View>

          <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
            <Text style={styles.deleteBtnText}>모델 삭제 (저장 공간 확보)</Text>
          </TouchableOpacity>
        </>
      )}

    </ScrollView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ phase }: { phase: Phase }) {
  if (phase === "checking" || phase === "resolving" || phase === "downloading") {
    return (
      <View style={[styles.badge, styles.badgeActive]}>
        <Text style={styles.badgeText}>다운로드 중</Text>
      </View>
    );
  }
  if (phase === "idle_downloaded") {
    return (
      <View style={[styles.badge, styles.badgeOk]}>
        <Text style={styles.badgeText}>다운로드됨</Text>
      </View>
    );
  }
  if (phase === "error") {
    return (
      <View style={[styles.badge, styles.badgeErr]}>
        <Text style={styles.badgeText}>오류</Text>
      </View>
    );
  }
  return (
    <View style={[styles.badge, styles.badgeNone]}>
      <Text style={styles.badgeText}>미다운로드</Text>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content:   { padding: 16, gap: 12, paddingBottom: 40 },

  card: {
    backgroundColor: "#141414",
    borderRadius: 12,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: "#222",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  modelName: { color: "#fff", fontSize: 17, fontWeight: "700" },

  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  badgeOk:     { backgroundColor: "#14532d" },
  badgeActive: { backgroundColor: "#1e3a5f" },
  badgeErr:    { backgroundColor: "#450a0a" },
  badgeNone:   { backgroundColor: "#222" },
  badgeText:   { color: "#ccc", fontSize: 11, fontWeight: "600" },

  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 2,
  },
  infoLabel: { color: "#666", fontSize: 13 },
  infoValue: { color: "#bbb", fontSize: 13, fontWeight: "500" },

  statusCard: {
    backgroundColor: "#141414",
    borderRadius: 12,
    padding: 20,
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: "#222",
  },
  statusText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  statusHint: { color: "#666", fontSize: 12, textAlign: "center" },

  progressTrack: {
    width: "100%",
    height: 6,
    backgroundColor: "#2a2a2a",
    borderRadius: 3,
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: "#2563eb", borderRadius: 3 },
  progressBytes: { color: "#888", fontSize: 12 },

  successCard: { borderColor: "#14532d" },
  successText: { color: "#22c55e", fontSize: 15, fontWeight: "700" },
  successHint: { color: "#666", fontSize: 12 },

  errorCard:  { borderColor: "#450a0a" },
  errorTitle: { color: "#ef4444", fontSize: 15, fontWeight: "700" },
  errorMsg:   { color: "#888", fontSize: 12, textAlign: "center" },

  ctaCard: {
    backgroundColor: "#141414",
    borderRadius: 12,
    padding: 20,
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: "#2563eb33",
  },
  ctaTitle: { color: "#fff", fontSize: 14, fontWeight: "600", textAlign: "center" },
  ctaHint:  { color: "#666", fontSize: 12, textAlign: "center" },

  primaryBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingHorizontal: 28,
    paddingVertical: 12,
    alignSelf: "stretch",
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },

  cancelBtn: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#333",
  },
  cancelBtnText: { color: "#aaa", fontSize: 13 },

  deleteBtn: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#450a0a",
  },
  deleteBtnText: { color: "#ef4444", fontSize: 14 },
});
