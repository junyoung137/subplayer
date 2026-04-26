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
    name: "Standard Model",
    sizeLabel: "~233 MB",
    sizeMB: 233,
    description: "",
    speedLabel: "",
    url: `${HF_BASE}/ggml-small-q8_0.bin`,
    coreMLUrl: `${HF_BASE}/ggml-small-encoder.mlmodelc.zip`,
  },
];

export function getModelById(id: string): WhisperModel | undefined {
  return WHISPER_MODELS.find((m) => m.id === id);
}
