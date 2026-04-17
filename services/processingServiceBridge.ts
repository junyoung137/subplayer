import { NativeModules } from "react-native";

const { ProcessingServiceModule } = NativeModules;

export const startBackgroundProcessing = (): void => {
  ProcessingServiceModule?.startService();
};

export const stopBackgroundProcessing = (): void => {
  ProcessingServiceModule?.stopService();
};

export const updateBackgroundProgress = (
  percent: number,
  message: string
): void => {
  ProcessingServiceModule?.updateProgress(Math.round(percent), message);
};