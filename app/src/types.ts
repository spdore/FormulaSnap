export type Page = "home" | "batch" | "history" | "settings";
export type RecognitionMode = "online" | "local" | "codex";
export type OutputFormat = "latex" | "mathml" | "word" | "plain";
export type ServiceAdapter = "deepseek-vision" | "openai-compatible-vision";

export interface ApiService {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  adapter: ServiceAdapter;
  visionVerified: boolean;
  hasKey: boolean;
  lastImageRequestAt?: number;
  lastImageRequestOk?: boolean;
  lastImageRequestError?: string;
}

export interface AppPreferences {
  selectedServiceId: string;
  mode: RecognitionMode;
  /** Independent batch engine selection; absent in older preference records. */
  batchMode?: RecognitionMode;
  /** Independent API service selection for batch recognition. */
  batchServiceId?: string;
  output: OutputFormat;
  autoTrim: boolean;
  localDevice: "cpu" | "cuda";
  codexCliPath: string;
  codexLastImageRequestAt?: number;
  codexLastImageRequestOk?: boolean;
  codexLastImageRequestError?: string;
}

export interface FormulaRecord {
  id: string;
  title: string;
  imageDataUrl: string;
  latex: string;
  createdAt: number;
  serviceName: string;
  mode: RecognitionMode;
  backend: string;
}

export interface CaptureScreen {
  id: string;
  name: string;
  width: number;
  height: number;
  imageDataUrl: string;
}

export interface LocalModelStatus {
  modelName: string;
  modelVersion: string;
  modelDirectory: string;
  modelInstalled: boolean;
  modelBytes: number;
  pythonExecutable: string | null;
  runtimeInstalled: boolean;
  runtimeManifestValid: boolean;
  statusReadable: boolean;
  availableProviders: string[];
  selectedDevice: string;
  activeBackend: string | null;
  workerRunning: boolean;
  runtimeError: string | null;
  error: string | null;
}

export interface LocalSettings {
  sourcePolicy: "auto" | "official" | "aliyun" | "tsinghua" | "custom";
  customPypiIndex: string;
  customCondaChannel: string;
  customMiniforgeUrl: string;
  customModelBaseUrl: string;
  storageDirectory: string;
  detectedRegion: "mainland" | "non-mainland" | "unknown" | string;
}

export interface LocalSetupProgress {
  taskId: string;
  status: "running" | "complete" | "failed" | "cancelled";
  stage: string;
  message: string;
  percent: number | null;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  bytesPerSecond?: number | null;
  elapsedMs?: number;
  estimatedRemainingMs?: number | null;
  lastActivityAt?: number;
}

export interface LocalRecognitionResult {
  latex: string;
  backend: string;
  elapsedMs: number;
}

export interface BatchItem {
  id: string;
  title: string;
  imageDataUrl: string;
  status: "queued" | "processing" | "done" | "failed" | "cancelled";
  latex: string;
  error: string;
  taskId?: string;
  recordId?: string;
  mode?: RecognitionMode;
  backend?: string;
  serviceName?: string;
}

export interface CodexCliStatus {
  status: "ready" | "not-installed" | "not-logged-in" | "check-error";
  executable: string | null;
  version: string | null;
  message: string;
}