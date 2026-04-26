import { useState, useEffect, useCallback } from "react";
import * as FileSystem from "expo-file-system/legacy";
import { loadModel, releaseModel, isModelLoaded } from "../services/whisperService";
import { useSettingsStore } from "../store/useSettingsStore";
import { getModelById, WHISPER_MODELS } from "../constants/whisperModels";

const MODEL_DIR = FileSystem.documentDirectory + "whisper-models/";

export interface ModelState {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  modelPath: string | null;
}

export function useWhisperModel() {
  const selectedModel = useSettingsStore((s) => s.whisperModel);
  const [state, setState] = useState<ModelState>({
    loaded: false,
    loading: false,
    error: null,
    modelPath: null,
  });

  const getModelPath = useCallback((modelId: string) => {
    const model = WHISPER_MODELS.find((m) => m.id === modelId);
    return MODEL_DIR + (model?.url.split("/").pop() ?? `ggml-${modelId}.bin`);
  }, []);

  const loadSelectedModel = useCallback(async () => {
    const modelPath = getModelPath(selectedModel);
    const info = await FileSystem.getInfoAsync(modelPath);

    if (!info.exists) {
      setState((s) => ({
        ...s,
        loaded: false,
        error: `Model '${selectedModel}' not downloaded. Please download it first.`,
      }));
      return;
    }

    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      await loadModel(modelPath);
      setState({ loaded: true, loading: false, error: null, modelPath });
    } catch (e) {
      setState({
        loaded: false,
        loading: false,
        error: String(e),
        modelPath: null,
      });
    }
  }, [selectedModel, getModelPath]);

  const unload = useCallback(async () => {
    await releaseModel();
    setState({ loaded: false, loading: false, error: null, modelPath: null });
  }, []);

  useEffect(() => {
    loadSelectedModel();
    return () => {
      releaseModel();
    };
  }, [selectedModel]);

  return { ...state, reload: loadSelectedModel, unload, getModelPath };
}
