import type { ApiService, AppPreferences, RecognitionMode } from "./types";

export interface RecognitionConfigSnapshot {
  readonly mode: RecognitionMode;
  readonly service: ApiService;
  readonly localDevice: AppPreferences["localDevice"];
  readonly codexCliPath: string;
}

export interface BatchEnginePreference {
  mode: RecognitionMode;
  serviceId: string;
}

export function isRecognitionMode(value: unknown): value is RecognitionMode {
  return value === "local" || value === "online" || value === "codex";
}

export function resolveBatchEnginePreference(
  preferences: AppPreferences,
  selectedServiceId: string,
  availableServiceIds: readonly string[]
): BatchEnginePreference {
  const mode = isRecognitionMode(preferences.batchMode)
    ? preferences.batchMode
    : isRecognitionMode(preferences.mode) ? preferences.mode : "local";
  const savedBatchService = preferences.batchServiceId;
  const serviceId = savedBatchService && availableServiceIds.includes(savedBatchService)
    ? savedBatchService
    : availableServiceIds.includes(selectedServiceId) ? selectedServiceId : availableServiceIds[0] ?? selectedServiceId;
  return { mode, serviceId };
}

export function createRecognitionConfigSnapshot(
  mode: RecognitionMode,
  service: ApiService,
  localDevice: AppPreferences["localDevice"],
  codexCliPath: string
): RecognitionConfigSnapshot {
  const copiedService = Object.freeze({ ...service }) as ApiService;
  return Object.freeze({ mode, service: copiedService, localDevice, codexCliPath: codexCliPath.trim() });
}

export async function dispatchRecognition<T>(
  config: RecognitionConfigSnapshot,
  handlers: {
    online: (service: ApiService) => Promise<T>;
    local: (device: AppPreferences["localDevice"]) => Promise<T>;
    codex: (cliPath: string) => Promise<T>;
  }
): Promise<T> {
  switch (config.mode) {
    case "online": return handlers.online(config.service);
    case "local": return handlers.local(config.localDevice);
    case "codex": return handlers.codex(config.codexCliPath);
    default: throw new Error("不支持的识别引擎：" + String(config.mode));
  }
}
