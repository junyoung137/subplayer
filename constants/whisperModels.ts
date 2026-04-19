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
    id: "Standard",
    name: "Standard(⭐Best)",
    sizeLabel: "466 MB",
    sizeMB: 466,
    description: "",
    speedLabel: "⚡⚡ fast",
    url: `${HF_BASE}/ggml-small.bin`,
    coreMLUrl: `${HF_BASE}/ggml-small-encoder.mlmodelc.zip`,
  },
  {
    id: "Advanced",
    name: "Advanced",
    sizeLabel: "1.5 GB",
    sizeMB: 1500,
    description: "",
    speedLabel: "⚡ Normal",
    url: `${HF_BASE}/ggml-medium.bin`,
    coreMLUrl: `${HF_BASE}/ggml-medium-encoder.mlmodelc.zip`,
  },
];

export function getModelById(id: string): WhisperModel | undefined {
  return WHISPER_MODELS.find((m) => m.id === id);
}
