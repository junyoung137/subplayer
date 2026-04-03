export interface WhisperModel {
  id: string;
  name: string;
  sizeLabel: string;
  sizeMB: number;
  description: string;
  speedLabel: string;   // e.g. "⚡⚡⚡ 초고속"
  url: string;
  coreMLUrl: string;
}

const HF_BASE =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export const WHISPER_MODELS: WhisperModel[] = [
  {
    id: "tiny",
    name: "Tiny (초고속, 낮은 정확도)",
    sizeLabel: "75 MB",
    sizeMB: 75,
    description: "가장 빠름 - 75MB, 짧은 영상 추천",
    speedLabel: "⚡⚡⚡ 초고속",
    url: `${HF_BASE}/ggml-tiny.bin`,
    coreMLUrl: `${HF_BASE}/ggml-tiny-encoder.mlmodelc.zip`,
  },
  {
    id: "small",
    name: "Small (빠름, 권장) ⭐",
    sizeLabel: "466 MB",
    sizeMB: 466,
    description: "속도와 정확도 균형 - 466MB",
    speedLabel: "⚡⚡ 빠름",
    url: `${HF_BASE}/ggml-small.bin`,
    coreMLUrl: `${HF_BASE}/ggml-small-encoder.mlmodelc.zip`,
  },
  {
    id: "medium",
    name: "Medium (균형잡힌 정확도)",
    sizeLabel: "1.5 GB",
    sizeMB: 1500,
    description: "높은 정확도 - 1.5GB",
    speedLabel: "⚡ 보통",
    url: `${HF_BASE}/ggml-medium.bin`,
    coreMLUrl: `${HF_BASE}/ggml-medium-encoder.mlmodelc.zip`,
  },
  {
    id: "large-v3",
    name: "Large-v3 (최고 정확도)",
    sizeLabel: "2.9 GB",
    sizeMB: 2900,
    description: "최고 정확도 - 2.9GB, 처리시간 4배",
    speedLabel: "🐢 느림",
    url: `${HF_BASE}/ggml-large-v3.bin`,
    coreMLUrl: `${HF_BASE}/ggml-large-v3-encoder.mlmodelc.zip`,
  },
];

export function getModelById(id: string): WhisperModel | undefined {
  return WHISPER_MODELS.find((m) => m.id === id);
}
