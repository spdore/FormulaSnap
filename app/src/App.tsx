import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, AlignLeft, CheckCircle2, ChevronRight, Clipboard, Clock3,
  Code2, Copy, Cpu, Crop, Eraser, Eye, FileText, FolderOpen, Globe2,
  History as HistoryIcon, Home, Image as ImageIcon, Layers, LoaderCircle,
  Maximize2, Minus, Monitor, Play, Plus, RotateCcw, RotateCw, Save,
  ScanLine, Search, Settings2, ShieldCheck, Sparkles, Square, Trash2, X,
  Pin, ZoomIn, ZoomOut
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFile, save as saveFile } from "@tauri-apps/plugin-dialog";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import katex from "katex";
import {
  cancelRecognition, captureScreens, checkApiKey, checkCodexCli, checkLocalModel, getLocalSettings, saveLocalSettings, chooseLocalStorageDirectory, copyFormulaImage,
  copyText, deleteApiKey, isDesktop, listenForFileDrop, makeId, pickImagePaths,
  readClipboardFormulaImage, readImagePath, readLocalFile, recognizeLocal, saveWordDocument,
  recognizeCodex, recognizeOnline, rebuildLocalEnvironment, setupLocalModel, storeApiKey, testApiService
} from "./bridge";
import { createEditableWordDocument, formatLabel, renderFormulaMathml, renderFormulaOmml, renderPlainFormula } from "./formats";
import { imageFromDataUrl, normalizedImagePoint, transformImage, trimWhiteMargins } from "./image-tools";
import {
  clearHistory as clearStoredHistory, defaultService, deleteRecord, deleteService,
  getRecord, listRecords, listServices, loadAppPreferences, saveAppPreferences, saveRecord, saveService, updateRecordLatexIfExists, updateServiceRequestStatus
} from "./storage";
import type {
  ApiService, AppPreferences, BatchItem, CaptureScreen, FormulaRecord,
  CodexCliStatus, LocalModelStatus, LocalSettings, LocalSetupProgress, OutputFormat, Page, RecognitionMode
} from "./types";
import "katex/dist/katex.min.css";
import "./App.css";
import { SelectMenu } from "./components/SelectMenu";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { BatchFormulaPreview } from "./components/BatchFormulaPreview";
import { imageApiBlockReason, isBuiltInDeepSeekVisionPreset } from "./recognition-service";
import { createRecognitionConfigSnapshot, dispatchRecognition, resolveBatchEnginePreference } from "./batch-engine";
import type { RecognitionConfigSnapshot } from "./batch-engine";

type ImageState = { name: string; originalUrl: string; url: string };
type Selection = { x: number; y: number; width: number; height: number };
type Notice = { message: string; tone: "success" | "error" | "info" };
type WorkStatus = "idle" | "processing" | "success" | "error" | "cancelled";

const navItems: { page: Page; label: string; icon: LucideIcon; shortcut?: string }[] = [
  { page: "home", label: "识别公式", icon: Home, shortcut: "Ctrl + V" },
  { page: "batch", label: "批量识别", icon: Layers },
  { page: "history", label: "历史记录", icon: Clock3 },
  { page: "settings", label: "设置", icon: Settings2 }
];

const outputOptions: { value: OutputFormat; label: string; sub: string; icon: LucideIcon }[] = [
  { value: "latex", label: "LaTeX", sub: "学术写作", icon: Code2 },
  { value: "mathml", label: "MathML", sub: "网页嵌入", icon: Code2 },
  { value: "word", label: "Word 公式", sub: "可编辑对象", icon: FileText },
  { value: "plain", label: "纯文本", sub: "便于编辑", icon: AlignLeft }
];

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || "公式图片";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return (Math.max(0, bytes / 1024)).toFixed(0) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return seconds + " 秒";
  return Math.floor(seconds / 60) + " 分 " + (seconds % 60) + " 秒";
}

function localProgressLabel(progress: LocalSetupProgress, extraElapsedMs: number): string {
  const elapsed = (progress.elapsedMs ?? 0) + extraElapsedMs;
  if (progress.downloadedBytes != null && progress.totalBytes != null) {
    const details = [formatBytes(progress.downloadedBytes) + " / " + formatBytes(progress.totalBytes)];
    if (progress.percent != null) details.unshift(progress.percent + "%");
    if (progress.bytesPerSecond != null && progress.bytesPerSecond > 0) details.push(formatBytes(progress.bytesPerSecond) + "/s");
    if (progress.estimatedRemainingMs != null) details.push("预计剩余 " + formatDuration(progress.estimatedRemainingMs));
    return progress.message + " · " + details.join(" · ");
  }
  return progress.message + " · 已用时 " + formatDuration(elapsed);
}

function StatusPill({ status }: { status: WorkStatus }) {
  if (status === "processing") return <span className="status-pill pending"><LoaderCircle size={14} className="spin" />识别中</span>;
  if (status === "success") return <span className="status-pill success"><CheckCircle2 size={14} />识别成功</span>;
  if (status === "error") return <span className="status-pill error"><AlertCircle size={14} />需要处理</span>;
  if (status === "cancelled") return <span className="status-pill neutral"><Square size={12} />已取消</span>;
  return null;
}

function batchEngineSourceLabel(mode?: RecognitionMode, serviceName?: string, backend?: string): string {
  if (!mode) return "尚未开始处理";
  const source = mode === "online" ? (serviceName || "API 服务")
    : mode === "codex" ? "Codex CLI"
      : "本地模型 · RapidLaTeXOCR";
  return source + (backend ? " · " + backend : "");
}

function App() {
  const customWindowFrame = (isDesktop() || import.meta.env.DEV) && /Windows/i.test(navigator.userAgent);
  const [page, setPage] = useState<Page>("home");
  const [image, setImage] = useState<ImageState | null>(null);
  const [latex, setLatex] = useState("");
  const [output, setOutput] = useState<OutputFormat>("latex");
  const [mode, setMode] = useState<RecognitionMode>("local");
  const [batchMode, setBatchMode] = useState<RecognitionMode>("local");
  const [batchServiceId, setBatchServiceId] = useState(defaultService.id);
  const [status, setStatus] = useState<WorkStatus>("idle");
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [autoTrim, setAutoTrim] = useState(true);
  const [services, setServices] = useState<ApiService[]>([]);
  const [serviceId, setServiceId] = useState(defaultService.id);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [credentialWarning, setCredentialWarning] = useState("");
  const [serviceDraft, setServiceDraft] = useState<ApiService>(defaultService);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [serviceTestState, setServiceTestState] = useState("");
  const [localStatus, setLocalStatus] = useState<LocalModelStatus | null>(null);
  const localStatusRef = useRef<LocalModelStatus | null>(null);
  const [localDevice, setLocalDevice] = useState<AppPreferences["localDevice"]>("cpu");
  const [setupProgress, setSetupProgress] = useState<LocalSetupProgress | null>(null);
  const [progressClock, setProgressClock] = useState(0);
  const [setupEventReceivedAt, setSetupEventReceivedAt] = useState(0);
  const [localAdvancedOpen, setLocalAdvancedOpen] = useState(false);
  const [localRebuildConfirmOpen, setLocalRebuildConfirmOpen] = useState(false);
  const [localSettings, setLocalSettings] = useState<LocalSettings>({
    sourcePolicy: "auto", customPypiIndex: "", customCondaChannel: "",
    customMiniforgeUrl: "", customModelBaseUrl: "", storageDirectory: "", detectedRegion: "unknown"
  });
  const [localSettingsBusy, setLocalSettingsBusy] = useState(false);
  const [localSettingsMessage, setLocalSettingsMessage] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [modelActionError, setModelActionError] = useState("");
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);
  const [apiKeyDeleteOpen, setApiKeyDeleteOpen] = useState(false);
  const [serviceDeleteOpen, setServiceDeleteOpen] = useState(false);
  const [records, setRecords] = useState<FormulaRecord[]>([]);
  const [currentRecordId, setCurrentRecordId] = useState<string | null>(null);
  const [currentBatchItemId, setCurrentBatchItemId] = useState<string | null>(null);
  const [batchReturnItemId, setBatchReturnItemId] = useState<string | null>(null);
  const [resultSource, setResultSource] = useState<{ mode: RecognitionMode; serviceName: string; backend: string } | null>(null);
  const [codexCliPath, setCodexCliPath] = useState("");
  const [codexCliStatus, setCodexCliStatus] = useState<CodexCliStatus | null>(null);
  const [codexChecking, setCodexChecking] = useState(false);
  const [codexLastImageRequest, setCodexLastImageRequest] = useState<{ at: number; ok: boolean; error?: string } | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [captureChoices, setCaptureChoices] = useState<CaptureScreen[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pinned, setPinned] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const batchListRef = useRef<HTMLDivElement>(null);
  const batchScrollTopRef = useRef(-1);
  const editSaveTimerRef = useRef<number | null>(null);
  const openSelectionSequenceRef = useRef(0);
  const captureDialogRef = useRef<HTMLElement>(null);
  const taskIdRef = useRef<string | null>(null);
  const batchTaskIdRef = useRef<string | null>(null);
  const batchBusyRef = useRef(false);
  const setupTaskIdRef = useRef<string | null>(null);
  const batchCancelledRef = useRef(false);
  const selectionStartRef = useRef<{ x: number; y: number } | null>(null);
  const autoTrimRef = useRef(autoTrim);

  const activeService = services.find((service) => service.id === serviceId) ?? services[0] ?? defaultService;
  const batchActiveService = services.find((service) => service.id === batchServiceId) ?? activeService;
  const localConfigured = Boolean(localStatus?.statusReadable && localStatus.modelInstalled && localStatus.runtimeInstalled && localStatus.runtimeManifestValid);
  const renderedPreview = useMemo(() => {
    if (!latex.trim()) return "";
    try {
      return katex.renderToString(latex, { displayMode: true, output: "htmlAndMathml", throwOnError: true, strict: "ignore" });
    } catch {
      return "";
    }
  }, [latex]);
  const historyMatches = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    if (!query) return records;
    return records.filter((record) => record.title.toLowerCase().includes(query) || record.latex.toLowerCase().includes(query));
  }, [historyQuery, records]);

  const showNotice = useCallback((message: string, tone: Notice["tone"] = "info") => {
    setNotice({ message, tone });
  }, []);

  const refreshRecords = useCallback(async () => {
    setRecords(await listRecords());
  }, []);

  const refreshLocalStatus = useCallback(async (): Promise<LocalModelStatus> => {
    try {
      const next = await checkLocalModel();
      setLocalStatus(next);
      localStatusRef.current = next;
      if (next.selectedDevice === "cuda" || next.selectedDevice === "cpu") setLocalDevice(next.selectedDevice);
      return next;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const fallback: LocalModelStatus = {
        modelName: "RapidLaTeXOCR", modelVersion: "v0.0.0 权重",
        modelDirectory: "无法读取模型目录", modelInstalled: false, modelBytes: 0,
        pythonExecutable: null, runtimeInstalled: false, runtimeManifestValid: false, statusReadable: false, availableProviders: [],
        selectedDevice: "cpu", activeBackend: null, workerRunning: false,
        runtimeError: message, error: message
      };
      setLocalStatus(fallback);
      localStatusRef.current = fallback;
      return fallback;
    }
  }, []);
  const ensureLocalReady = useCallback(async (preferredDevice: AppPreferences["localDevice"]): Promise<AppPreferences["localDevice"]> => {
    setModelBusy(true);
    try {
      let status = localStatusRef.current;
      if (!status) status = await refreshLocalStatus();
      if (!status.statusReadable) throw new Error(status.error || "无法读取本地环境状态；请检查应用数据目录后重试。");
      if (!status.modelInstalled || !status.runtimeInstalled || !status.runtimeManifestValid) {
        setModelActionError("");
        showNotice("正在准备本地公式识别。模型已随安装包提供，应用会自动配置隔离运行环境。", "info");
        const taskId = makeId();
        setupTaskIdRef.current = taskId;
        setSetupProgress(null);
        const backend = await setupLocalModel(taskId);
        setupTaskIdRef.current = null;
        setModelActionError("");
        const device: AppPreferences["localDevice"] = backend === "CUDAExecutionProvider" ? "cuda" : "cpu";
        setLocalDevice(device);
        await refreshLocalStatus();
        return device;
      }
      const device = preferredDevice;
      const expectedBackend = device === "cuda" ? "CUDAExecutionProvider" : "CPUExecutionProvider";
      setLocalDevice(device);
      if (!status.workerRunning || status.activeBackend !== expectedBackend) {
        const backend = await invoke<string>("load_local_model", { device });
        setLocalStatus((current) => current ? { ...current, activeBackend: backend, workerRunning: true, selectedDevice: device } : current);
        localStatusRef.current = { ...status, activeBackend: backend, workerRunning: true, selectedDevice: device };
      }
      return device;
    } catch (reason) {
      setupTaskIdRef.current = null;
      const message = reason instanceof Error ? reason.message : String(reason);
      setModelActionError(message);
      await refreshLocalStatus();
      throw reason;
    } finally {
      setModelBusy(false);
    }
  }, [refreshLocalStatus, showNotice]);
  const installImage = useCallback(async (name: string, dataUrl: string) => {
    await imageFromDataUrl(dataUrl);
    let processed = dataUrl;
    if (autoTrimRef.current) processed = await trimWhiteMargins(dataUrl).catch(() => dataUrl);
    setImage({ name, originalUrl: dataUrl, url: processed });
    setLatex("");
    setElapsed(null);
    setStatus("idle");
    setError("");
    setSelection(null);
    setIsSelecting(false);
    setCurrentRecordId(null);
    setCurrentBatchItemId(null);
    setBatchReturnItemId(null);
    setResultSource(null);
    setZoom(100);
    setPage("home");
  }, []);

  useEffect(() => {
    if (!captureChoices) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = captureDialogRef.current;
    dialog?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCaptureChoices(null);
      } else if (event.key === "Tab" && dialog) {
        const buttons = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled)"));
        if (!buttons.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [captureChoices]);
  useEffect(() => { autoTrimRef.current = autoTrim; }, [autoTrim]);
  useEffect(() => {
    if (page !== "batch" || batchScrollTopRef.current < 0) return;
    const scrollTop = batchScrollTopRef.current;
    requestAnimationFrame(() => {
      if (batchListRef.current) batchListRef.current.scrollTop = scrollTop;
      batchScrollTopRef.current = -1;
    });
  }, [page, batchItems.length]);

  const openPaths = useCallback(async (paths: string[], preferBatch = false) => {
    if (!paths.length) return;
    setIsBusy(true);
    try {
      const loaded: { name: string; url: string }[] = [];
      const failures: string[] = [];
      for (const path of paths) {
        try {
          loaded.push({ name: fileName(path), url: await readImagePath(path) });
        } catch (reason) {
          failures.push(fileName(path) + ": " + (reason instanceof Error ? reason.message : String(reason)));
        }
      }
      if (loaded.length > 1 || preferBatch) {
        setBatchItems((items) => items.concat(loaded.map((item) => ({
          id: makeId(), title: item.name, imageDataUrl: item.url,
          status: "queued" as const, latex: "", error: ""
        }))));
        setPage("batch");
      } else if (loaded[0]) {
        await installImage(loaded[0].name, loaded[0].url);
      }
      if (failures.length) showNotice(failures.join("；"), "error");
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setIsBusy(false);
    }
  }, [installImage, showNotice]);

  const chooseFiles = useCallback(async (multiple = false) => {
    try {
      if (isDesktop()) {
        const paths = await pickImagePaths(multiple);
        await openPaths(paths, multiple);
      } else if (fileInputRef.current) {
        fileInputRef.current.multiple = multiple;
        fileInputRef.current.click();
      }
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : "打开图片选择器失败。", "error");
    }
  }, [openPaths, showNotice]);

  const captureDesktop = useCallback(async () => {
    try {
      const screens = await captureScreens();
      if (!screens.length) throw new Error("没有可用的显示器截图。");
      if (screens.length === 1) await installImage(screens[0].name, screens[0].imageDataUrl);
      else setCaptureChoices(screens);
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : String(reason), "error");
    }
  }, [installImage, showNotice]);

  const pasteImage = useCallback(async () => {
    setClipboardBusy(true);
    try {
      const dataUrl = await readClipboardFormulaImage();
      await installImage("剪贴板图片", dataUrl);
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setClipboardBusy(false);
    }
  }, [installImage, showNotice]);

  useEffect(() => {
    let alive = true;
    void getLocalSettings().then((settings) => { if (alive) setLocalSettings(settings); })
      .catch((reason) => { if (alive) setLocalSettingsMessage("读取本地高级设置失败：" + String(reason)); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    void Promise.all([listServices(), listRecords(), loadAppPreferences()]).then(async ([rows, savedRecords, savedPreferences]) => {
      let keyStoreUnavailable = false;
      const verifiedRows = await Promise.all(rows.map(async (service) => {
        try { return { ...service, hasKey: await checkApiKey(service.id) }; }
        catch { keyStoreUnavailable = true; return { ...service, hasKey: false }; }
      }));
      if (!alive) return;
      const selectedService = verifiedRows.find((service) => service.id === savedPreferences.selectedServiceId)
        ?? verifiedRows[0] ?? defaultService;
      const batchPreference = resolveBatchEnginePreference(savedPreferences, selectedService.id, verifiedRows.map((service) => service.id));
      setServices(verifiedRows);
      setServiceId(selectedService.id);
      setBatchMode(batchPreference.mode);
      setBatchServiceId(batchPreference.serviceId);
      setServiceDraft(selectedService);
      setRecords(savedRecords);
      setMode(savedPreferences.mode);
      setCodexCliPath(savedPreferences.codexCliPath ?? "");
      setCodexLastImageRequest(savedPreferences.codexLastImageRequestAt ? { at: savedPreferences.codexLastImageRequestAt, ok: Boolean(savedPreferences.codexLastImageRequestOk), error: savedPreferences.codexLastImageRequestError } : null);
      setOutput(savedPreferences.output);
      setAutoTrim(savedPreferences.autoTrim);
      setLocalDevice(savedPreferences.localDevice);
      setCredentialWarning(keyStoreUnavailable ? "Windows 系统凭据库暂不可用。请检查 Windows 凭据管理器后重试；密钥状态尚未读取。" : "");
      setPreferencesLoaded(true);
    }).catch((reason) => showNotice("读取本地数据失败：" + String(reason), "error"));
    const localStatusTimer = window.setTimeout(() => { void refreshLocalStatus(); }, 0);
    let stopDrop: (() => void) | undefined;
    void listenForFileDrop((paths) => { void openPaths(paths, paths.length > 1); })
      .then((stop) => { stopDrop = stop; }).catch(() => undefined);
    return () => {
      alive = false;
      window.clearTimeout(localStatusTimer);
      stopDrop?.();
    };
  }, [openPaths, refreshLocalStatus, showNotice]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    void saveAppPreferences({ selectedServiceId: serviceId, mode, batchMode, batchServiceId, output, autoTrim, localDevice, codexCliPath, codexLastImageRequestAt: codexLastImageRequest?.at, codexLastImageRequestOk: codexLastImageRequest?.ok, codexLastImageRequestError: codexLastImageRequest?.error })
      .catch((reason) => showNotice("保存应用偏好失败：" + String(reason), "error"));
  }, [autoTrim, batchMode, batchServiceId, codexCliPath, codexLastImageRequest, localDevice, mode, output, preferencesLoaded, serviceId, showNotice]);

  useEffect(() => {
    if (!isDesktop()) return;
    let registered = false;
    let disposed = false;
    const shortcut = "CommandOrControl+Shift+A";
    void register(shortcut, () => { void captureDesktop(); }).then(() => {
      if (disposed) void unregister(shortcut).catch(() => undefined);
      else registered = true;
    }).catch(() => undefined);
    return () => { disposed = true; if (registered) void unregister(shortcut).catch(() => undefined); };
  }, [captureDesktop]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pasteImage();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [pasteImage]);

  useEffect(() => {
    const timer = window.setTimeout(() => setNotice(null), 4600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!modelBusy) return;
    const timer = window.setInterval(() => setProgressClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [modelBusy]);

  useEffect(() => {
    if (!isDesktop()) return;
    let stopSetup: (() => void) | undefined;
    void listen<LocalSetupProgress>("local-setup-progress", (event) => {
      if (setupTaskIdRef.current && event.payload.taskId !== setupTaskIdRef.current) return;
      if (!setupTaskIdRef.current) setupTaskIdRef.current = event.payload.taskId;
      setSetupEventReceivedAt(Date.now());
      setSetupProgress(event.payload);
    }).then((stop) => { stopSetup = stop; }).catch(() => undefined);
    return () => { stopSetup?.(); };
  }, []);

  useEffect(() => {
    if (!currentRecordId || !image || !latex) return;
    const current = records.find((record) => record.id === currentRecordId);
    if (!current || current.latex === latex) return;
    const timer = window.setTimeout(() => {
      const updated = { ...current, latex };
      void saveRecord(updated).then(() => {
        setRecords((all) => all.map((record) => record.id === updated.id ? updated : record));
      }).catch(() => showNotice("保存编辑内容失败。", "error"));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [currentRecordId, image, latex, records, showNotice]);

  const handleInputFiles = useCallback(async (files: FileList | File[]) => {
    const selected = Array.from(files);
    if (!selected.length) return;
    setIsBusy(true);
    try {
      const loaded: { name: string; url: string }[] = [];
      for (const file of selected) loaded.push({ name: file.name, url: await readLocalFile(file) });
      if (loaded.length > 1) {
        const queue: BatchItem[] = [];
        for (const item of loaded) {
          const processed = autoTrim ? await trimWhiteMargins(item.url).catch(() => item.url) : item.url;
          queue.push({ id: makeId(), title: item.name, imageDataUrl: processed, status: "queued", latex: "", error: "" });
        }
        setBatchItems((items) => items.concat(queue));
        setPage("batch");
      } else if (loaded[0]) {
        await installImage(loaded[0].name, loaded[0].url);
      }
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setIsBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [autoTrim, installImage, showNotice]);

  const cropSelection = useCallback(async () => {
    if (!image || !selection) return;
    try {
      const source = await imageFromDataUrl(image.url);
      const left = Math.min(source.naturalWidth - 1, Math.max(0, Math.round(selection.x * source.naturalWidth)));
      const top = Math.min(source.naturalHeight - 1, Math.max(0, Math.round(selection.y * source.naturalHeight)));
      const width = Math.max(1, Math.round(selection.width * source.naturalWidth));
      const height = Math.max(1, Math.round(selection.height * source.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.min(width, source.naturalWidth - left));
      canvas.height = Math.max(1, Math.min(height, source.naturalHeight - top));
      canvas.getContext("2d")?.drawImage(source, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      setImage({ ...image, url: canvas.toDataURL("image/png") });
      setSelection(null);
      setIsSelecting(false);
      setZoom(100);
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : String(reason), "error");
    }
  }, [image, selection, showNotice]);

  const handleSelectionDown = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!isSelecting) return;
    const point = normalizedImagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    const { x, y } = point;
    selectionStartRef.current = point;
    setSelection({ x, y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleSelectionMove = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!isSelecting || !selectionStartRef.current) return;
    const { x, y } = normalizedImagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    const start = selectionStartRef.current;
    setSelection({ x: Math.min(x, start.x), y: Math.min(y, start.y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) });
  };

  const handleSelectionUp = () => {
    if (selection && (selection.width < 0.015 || selection.height < 0.015)) setSelection(null);
    selectionStartRef.current = null;
  };

  const changeImage = useCallback(async (kind: "rotate" | "sharpen" | "background") => {
    if (!image) return;
    try {
      setImage({ ...image, url: await transformImage(image.url, kind) });
      setSelection(null);
      const message = kind === "rotate" ? "图片已旋转 90°。" :
        kind === "sharpen" ? "已提高局部对比度；没有补造原图中缺失的笔画。" :
          "已将浅色像素映射为白色、深色像素映射为黑色。";
      showNotice(message, "success");
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : String(reason), "error");
    }
  }, [image, showNotice]);

  const restoreOriginal = useCallback(() => {
    if (!image) return;
    setImage({ ...image, url: image.originalUrl });
    setSelection(null);
    setIsSelecting(false);
    showNotice("已恢复导入时的原图。", "success");
  }, [image, showNotice]);

  const trimCurrentImage = useCallback(async () => {
    if (!image) return;
    try {
      setImage({ ...image, url: await trimWhiteMargins(image.url) });
      setSelection(null);
      showNotice("已按深色像素裁去四周空白；图片内部内容会整体保留。", "success");
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : String(reason), "error");
    }
  }, [image, showNotice]);

  const recordOnlineOutcome = useCallback(async (id: string, ok: boolean, error?: string) => {
    try {
      const updated = await updateServiceRequestStatus(id, Date.now(), ok, error);
      if (!updated) return;
      setServices((rows) => rows.map((row) => row.id === id ? updated : row));
      setServiceDraft((current) => current.id === id ? updated : current);
    } catch {
      // Recognition must report its own result even if optional status persistence fails.
    }
  }, []);

  const runFormulaRecognition = useCallback(async (
    taskId: string,
    imageDataUrl: string,
    config: RecognitionConfigSnapshot
  ): Promise<{ latex: string; backend: string; serviceName: string; elapsedMs: number }> => {
    return dispatchRecognition(config, {
      online: async (serviceToUse) => {
        const blockReason = imageApiBlockReason(serviceToUse);
        if (blockReason) throw new Error(blockReason);
        const started = performance.now();
        try {
          const latex = await recognizeOnline(taskId, imageDataUrl, serviceToUse);
          await recordOnlineOutcome(serviceToUse.id, true);
          return { latex, backend: serviceToUse.model, serviceName: serviceToUse.name, elapsedMs: performance.now() - started };
        } catch (reason) {
          await recordOnlineOutcome(serviceToUse.id, false, reason instanceof Error ? reason.message : String(reason));
          throw reason;
        }
      },
      codex: async (cliPath) => {
        try {
          const result = await recognizeCodex(taskId, imageDataUrl, cliPath);
          setCodexLastImageRequest({ at: Date.now(), ok: true });
          return { latex: result.latex, backend: result.backend, serviceName: "Codex CLI", elapsedMs: result.elapsedMs };
        } catch (reason) {
          setCodexLastImageRequest({ at: Date.now(), ok: false, error: (reason instanceof Error ? reason.message : String(reason)).slice(0, 240) });
          throw reason;
        }
      },
      local: async (device) => {
        const recognitionDevice = await ensureLocalReady(device);
        const result = await recognizeLocal(taskId, imageDataUrl, recognitionDevice);
        return { latex: result.latex, backend: result.backend, serviceName: "RapidLaTeXOCR", elapsedMs: result.elapsedMs };
      }
    });
  }, [ensureLocalReady, recordOnlineOutcome]);

  const recognizeCurrent = useCallback(async () => {
    if (taskIdRef.current) return;
    if (!image) {
      showNotice("先导入、粘贴或截取公式图片。", "info");
      return;
    }
    if (mode === "online") {
      const blockReason = imageApiBlockReason(activeService);
      if (blockReason) {
        setError(blockReason);
        setStatus("error");
        showNotice("请先配置 API Key。密钥只保存在系统凭据库中。", "error");
        return;
      }
    }

    const taskId = makeId();
    taskIdRef.current = taskId;
    setStatus("processing");
    setError("");
    setElapsed(null);
    const started = performance.now();
    const config = createRecognitionConfigSnapshot(mode, activeService, localDevice, codexCliPath);
    try {
      const result = await runFormulaRecognition(taskId, image.url, config);
      const recognized = result.latex.trim();
      if (!recognized) throw new Error("服务没有返回公式源码，请检查图片后重试。");
      setLatex(recognized);
      setStatus("success");
      setElapsed(result.elapsedMs ? result.elapsedMs / 1000 : (performance.now() - started) / 1000);
      setResultSource({ mode: config.mode, serviceName: result.serviceName, backend: result.backend });
      const saved: FormulaRecord = {
        id: makeId(), title: image.name, imageDataUrl: image.url, latex: recognized,
        createdAt: Date.now(), serviceName: result.serviceName, mode: config.mode, backend: result.backend
      };
      await saveRecord(saved);
      setCurrentRecordId(saved.id);
      setCurrentBatchItemId(null);
      setBatchReturnItemId(null);
      await refreshRecords();
      showNotice("已识别并保存到历史记录。", "success");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (/cancelled|取消/i.test(message)) {
        setStatus("cancelled");
        setError("识别已取消。");
      } else {
        setStatus("error");
        setError(message);
      }
    } finally {
      taskIdRef.current = null;
    }
  }, [activeService, codexCliPath, image, localDevice, mode, refreshRecords, runFormulaRecognition, showNotice]);
  const cancelCurrent = useCallback(async () => {
    try {
      const taskId = taskIdRef.current;
      if (taskId) await cancelRecognition(taskId);
      setStatus("cancelled");
      setError("识别已取消。");
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : "取消识别失败。", "error");
    }
  }, [showNotice]);

  const editLatex = useCallback((next: string) => {
    setLatex(next);
    if (status === "success") setStatus("idle");
    if (currentBatchItemId) {
      const itemId = currentBatchItemId;
      setBatchItems((rows) => rows.map((row) => row.id === itemId ? { ...row, latex: next } : row));
    }
    if (currentRecordId) {
      const recordId = currentRecordId;
      if (editSaveTimerRef.current !== null) window.clearTimeout(editSaveTimerRef.current);
      editSaveTimerRef.current = window.setTimeout(() => {
        void updateRecordLatexIfExists(recordId, next).then((updated) => {
          if (updated) {
            setRecords((rows) => rows.map((row) => row.id === updated.id ? updated : row));
            return;
          }
          setCurrentRecordId((current) => current === recordId ? null : current);
          setBatchItems((rows) => rows.map((row) => row.recordId === recordId ? { ...row, recordId: undefined } : row));
          showNotice("这条历史记录已不存在；当前编辑不会重新创建历史记录。", "info");
        }).catch((reason) => showNotice(reason instanceof Error ? "保存编辑失败：" + reason.message : "保存编辑失败。", "error"));
      }, 240);
    }
  }, [currentBatchItemId, currentRecordId, showNotice, status]);
  const copyWithNotice = useCallback(async (value: string, successMessage: string) => {
    try {
      await copyText(value);
      showNotice(successMessage, "success");
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : "复制失败，请重试。", "error");
    }
  }, [showNotice]);
  const copySelectedOutput = useCallback(async () => {
    if (!latex.trim()) {
      showNotice("目前没有可复制的公式。", "info");
      return;
    }
    try {
      let text = latex;
      if (output === "mathml") text = renderFormulaMathml(latex);
      if (output === "plain") text = renderPlainFormula(latex);
      if (output === "word") throw new Error("Word 公式请使用“导出可编辑 DOCX”。");
      await copyText(text);
      showNotice("已复制 " + formatLabel(output) + "。", "success");
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : String(reason), "error");
    }
  }, [latex, output, showNotice]);

  const exportWord = useCallback(async () => {
    if (!latex.trim()) return;
    try {
      const blob = await createEditableWordDocument(latex);
      if (isDesktop()) {
        const path = await saveFile({
          title: "导出可编辑 Word 公式",
          defaultPath: "FormulaSnap-equation.docx",
          filters: [{ name: "Word 文档", extensions: ["docx"] }]
        });
        if (!path) return;
        await saveWordDocument(path, blob);
      } else {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "FormulaSnap-equation.docx";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1200);
      }
      showNotice("DOCX 已写入所选位置，包含可编辑的 Office Math 公式。", "success");
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : "保存 DOCX 失败。", "error");
    }
  }, [latex, showNotice]);
  const copyImage = useCallback(async () => {
    if (!previewRef.current || !latex.trim() || !renderedPreview) return;
    try {
      await copyFormulaImage(previewRef.current);
      showNotice("公式 PNG 已复制到剪贴板。", "success");
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : String(reason), "error");
    }
  }, [latex, renderedPreview, showNotice]);


  const openFormulaResult = useCallback(async (record: FormulaRecord, batchItemId?: string) => {
    const sequence = ++openSelectionSequenceRef.current;
    try {
      await imageFromDataUrl(record.imageDataUrl);
      if (sequence !== openSelectionSequenceRef.current) return;
      setImage({ name: record.title, originalUrl: record.imageDataUrl, url: record.imageDataUrl });
      setLatex(record.latex);
      setElapsed(null);
      setStatus("success");
      setError("");
      setSelection(null);
      setIsSelecting(false);
      setZoom(100);
      setCurrentRecordId(record.id || null);
      setCurrentBatchItemId(batchItemId ?? null);
      setResultSource({ mode: record.mode, serviceName: record.serviceName, backend: record.backend });
      setBatchReturnItemId(batchItemId ?? null);
      if (!batchItemId) batchScrollTopRef.current = -1;
      setPage("home");
    } catch (reason) {
      if (sequence === openSelectionSequenceRef.current) {
        showNotice("无法打开公式图片：" + (reason instanceof Error ? reason.message : String(reason)), "error");
      }
    }
  }, [showNotice]);

  const selectRecord = useCallback((record: FormulaRecord) => openFormulaResult(record), [openFormulaResult]);

  const openBatchResult = useCallback(async (item: BatchItem) => {
    if (item.status !== "done") return;
    const sequence = ++openSelectionSequenceRef.current;
    batchScrollTopRef.current = batchListRef.current?.scrollTop ?? 0;
    let record: FormulaRecord | undefined;
    if (item.recordId) {
      try { record = await getRecord(item.recordId); }
      catch (reason) { showNotice("读取对应历史记录失败：" + String(reason), "error"); return; }
    }
    if (sequence !== openSelectionSequenceRef.current) return;
    if (record) {
      setBatchItems((rows) => rows.map((row) => row.id === item.id ? {
        ...row, recordId: record!.id, imageDataUrl: record!.imageDataUrl, title: record!.title,
        latex: record!.latex, mode: record!.mode, backend: record!.backend, serviceName: record!.serviceName
      } : row));
      await openFormulaResult(record, item.id);
      return;
    }
    const missingHistory = Boolean(item.recordId);
    const fallback: FormulaRecord = {
      id: "", title: item.title, imageDataUrl: item.imageDataUrl, latex: item.latex,
      createdAt: Date.now(), serviceName: item.serviceName ?? "批量识别结果",
      mode: item.mode ?? mode, backend: item.backend ?? ""
    };
    if (missingHistory) {
      setBatchItems((rows) => rows.map((row) => row.id === item.id ? { ...row, recordId: undefined } : row));
      showNotice("对应历史记录已删除；仍可查看并编辑这条批量结果。", "info");
    } else {
      showNotice("旧批量项没有历史记录关联；本次查看会使用队列中保存的图片和源码。", "info");
    }
    await openFormulaResult(fallback, item.id);
  }, [mode, openFormulaResult, showNotice]);

  const returnToBatch = useCallback(() => {
    setCurrentRecordId(null);
    setCurrentBatchItemId(null);
    setBatchReturnItemId(null);
    setPage("batch");
  }, []);
  const persistService = useCallback(async () => {
    const endpoint = serviceDraft.endpoint.trim();
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        throw new Error("API 地址必须使用 HTTPS；本机回环地址允许使用 HTTP。");
      }
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : "API 地址无效。", "error");
      return;
    }
    if (!serviceDraft.name.trim() || !serviceDraft.model.trim()) {
      showNotice("请填写服务名称和模型名称。", "error");
      return;
    }
    setModelBusy(true);
    try {
      const saved = { ...serviceDraft, name: serviceDraft.name.trim(), endpoint, model: serviceDraft.model.trim() };
      if (apiKeyDraft.trim()) {
        await storeApiKey(saved.id, apiKeyDraft.trim());
        saved.hasKey = true;
      }
      await saveService(saved);
      const rows = await listServices();
      setServices(rows.map((item) => item.id === saved.id ? saved : item));
      setServiceId(saved.id);
      setServiceDraft(saved);
      setApiKeyDraft("");
      setServiceTestState("");
      setCredentialWarning("");
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setModelBusy(false);
    }
  }, [apiKeyDraft, serviceDraft, showNotice]);

  const removeCurrentService = useCallback(async () => {
    try {
      await deleteApiKey(serviceDraft.id);
      await deleteService(serviceDraft.id);
      const storedRows = await listServices();
      const rows = storedRows.map((item) => ({
        ...item,
        hasKey: services.find((current) => current.id === item.id)?.hasKey ?? item.hasKey
      }));
      setServices(rows);
      setServiceDraft(rows[0] ?? defaultService);
      setServiceId(rows[0]?.id ?? defaultService.id);
      setBatchServiceId((current) => rows.some((row) => row.id === current) ? current : rows[0]?.id ?? defaultService.id);
      setServiceDeleteOpen(false);
      showNotice("API 服务和对应的密钥已删除。", "success");
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : String(reason), "error");
    }
  }, [serviceDraft.id, services, showNotice]);

  const removeCurrentApiKey = useCallback(async () => {
    try {
      await deleteApiKey(serviceDraft.id);
      const updated = { ...serviceDraft, hasKey: false };
      setServiceDraft(updated);
      setServices((rows) => rows.map((row) => row.id === updated.id ? updated : row));
      setApiKeyDeleteOpen(false);
      showNotice("已从系统凭据库删除密钥。", "success");
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : String(reason), "error");
    }
  }, [serviceDraft, showNotice]);

  const testService = useCallback(async (withImage: boolean) => {
    setModelBusy(true);
    setServiceTestState(withImage ? "正在运行可选图片诊断…" : "正在测试连接…");
    try {
      const result = await testApiService(serviceDraft, withImage ? image?.url : undefined);
      if (withImage) {
        await recordOnlineOutcome(serviceDraft.id, true);
        setServiceTestState("图片请求成功；服务返回了可处理的图像响应。");
      } else {
        setServiceTestState("连接成功：" + result.slice(0, 100));
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (withImage) await recordOnlineOutcome(serviceDraft.id, false, message);
      setServiceTestState("测试失败：" + message);
    } finally {
      setModelBusy(false);
    }
  }, [image, recordOnlineOutcome, serviceDraft]);

  const checkCodexConnection = useCallback(async () => {
    setCodexChecking(true);
    try {
      const checked = await checkCodexCli(codexCliPath);
      setCodexCliStatus(checked);
    } catch (reason) {
      setCodexCliStatus({
        status: "check-error", executable: codexCliPath || null, version: null,
        message: reason instanceof Error ? reason.message : "检查 Codex CLI 失败。"
      });
    } finally {
      setCodexChecking(false);
    }
  }, [codexCliPath]);

  useEffect(() => {
    if (page !== "batch" || batchMode !== "codex" || codexCliStatus !== null || codexChecking) return;
    const timer = window.setTimeout(() => { void checkCodexConnection(); }, 0);
    return () => window.clearTimeout(timer);
  }, [batchMode, checkCodexConnection, codexChecking, codexCliStatus, page]);

  const chooseCodexExecutable = useCallback(async () => {
    try {
      const chosen = await openFile({ multiple: false, title: "选择原生 Codex CLI 可执行文件", filters: [{ name: "Windows 程序", extensions: ["exe"] }] });
      if (typeof chosen === "string") {
        setCodexCliPath(chosen);
        setCodexCliStatus(null);
      }
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : "打开文件选择器失败。", "error");
    }
  }, [showNotice]);
  const createCustomService = useCallback(() => {
    const next: ApiService = {
      id: makeId(), name: "自定义视觉服务", endpoint: "https://", model: "",
      adapter: "openai-compatible-vision", visionVerified: false, hasKey: false
    };
    setServiceDraft(next);
    setApiKeyDraft("");
    setServiceTestState("");
  }, []);

  const addScreenToWorkspace = useCallback(async (screen: CaptureScreen) => {
    setCaptureChoices(null);
    try {
      await installImage(screen.name, screen.imageDataUrl);
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : "读取屏幕截图失败。", "error");
    }
  }, [installImage, showNotice]);

  const addBrowserDrop = useCallback(async (event: React.DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    await handleInputFiles(event.dataTransfer.files);
  }, [handleInputFiles]);

  const startBatch = useCallback(async () => {
    if (batchBusyRef.current) return;
    const pendingItems = batchItems.filter((item) => item.status !== "done");
    if (!pendingItems.length) return;

    // Copy all mutable settings at click time. Later single-image/API/Codex setting changes
    // cannot change this round's provider or service.
    const initialConfig = createRecognitionConfigSnapshot(batchMode, batchActiveService, localDevice, codexCliPath);
    if (initialConfig.mode === "online") {
      const blockReason = imageApiBlockReason(initialConfig.service);
      if (blockReason) {
        setBatchItems((rows) => rows.map((row) => pendingItems.some((pending) => pending.id === row.id) ? {
          ...row, status: "failed", error: blockReason, mode: initialConfig.mode,
          backend: initialConfig.service.model, serviceName: initialConfig.service.name
        } : row));
        showNotice(blockReason, "error");
        return;
      }
    }
    if (initialConfig.mode === "codex" && codexCliStatus && codexCliStatus.status !== "ready") {
      setBatchItems((rows) => rows.map((row) => pendingItems.some((pending) => pending.id === row.id) ? {
        ...row, status: "failed", error: codexCliStatus.message, mode: initialConfig.mode,
        serviceName: "Codex CLI"
      } : row));
      showNotice(codexCliStatus.message, "error");
      return;
    }

    batchCancelledRef.current = false;
    batchBusyRef.current = true;
    setBatchBusy(true);
    let config = initialConfig;
    let completed = 0;
    try {
      // Local is the only provider that prepares or loads the isolated Python runtime.
      // Resolve its effective device before processing so every item uses one fixed config.
      if (config.mode === "local") {
        const actualDevice = await ensureLocalReady(config.localDevice);
        if (batchCancelledRef.current) throw new Error("批量任务已取消。");
        config = createRecognitionConfigSnapshot(config.mode, config.service, actualDevice, config.codexCliPath);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const cancelled = /cancelled|取消/i.test(message) || batchCancelledRef.current;
      setBatchItems((rows) => rows.map((row) => pendingItems.some((pending) => pending.id === row.id) ? {
        ...row, status: cancelled ? "cancelled" : "failed", error: message,
        mode: initialConfig.mode,
        serviceName: initialConfig.mode === "online" ? initialConfig.service.name : initialConfig.mode === "codex" ? "Codex CLI" : "RapidLaTeXOCR",
        backend: initialConfig.mode === "online" ? initialConfig.service.model : undefined
      } : row));
      batchBusyRef.current = false;
      setBatchBusy(false);
      showNotice(message, "error");
      return;
    }

    for (const item of pendingItems) {
      if (batchCancelledRef.current) break;
      const serviceName = config.mode === "online" ? config.service.name : config.mode === "codex" ? "Codex CLI" : "RapidLaTeXOCR";
      const taskId = makeId();
      batchTaskIdRef.current = taskId;
      setBatchItems((rows) => rows.map((row) => row.id === item.id ? {
        ...row, status: "processing", taskId, error: "", mode: config.mode,
        backend: config.mode === "online" ? config.service.model : undefined, serviceName
      } : row));
      try {
        const result = await runFormulaRecognition(taskId, item.imageDataUrl, config);
        const recognized = result.latex.trim();
        if (!recognized) throw new Error("服务没有返回公式源码。");
        const saved: FormulaRecord = {
          id: makeId(), title: item.title, imageDataUrl: item.imageDataUrl,
          latex: recognized, createdAt: Date.now(), serviceName: result.serviceName,
          mode: config.mode, backend: result.backend
        };
        await saveRecord(saved);
        setBatchItems((rows) => rows.map((row) => row.id === item.id ? {
          ...row, status: "done", latex: recognized, error: "", recordId: saved.id,
          mode: config.mode, backend: result.backend, serviceName: result.serviceName
        } : row));
        completed += 1;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setBatchItems((rows) => rows.map((row) => row.id === item.id ? {
          ...row, status: /cancelled|取消/i.test(message) ? "cancelled" : "failed", error: message,
          mode: config.mode, backend: config.mode === "online" ? config.service.model : undefined, serviceName
        } : row));
        if (/cancelled|取消/i.test(message)) break;
      } finally {
        batchTaskIdRef.current = null;
      }
    }
    batchBusyRef.current = false;
    setBatchBusy(false);
    let historyRefreshFailed = false;
    try {
      await refreshRecords();
    } catch (reason) {
      historyRefreshFailed = true;
      showNotice(reason instanceof Error ? "更新历史记录失败：" + reason.message : "更新历史记录失败。", "error");
    }
    if (!batchCancelledRef.current && !historyRefreshFailed) {
      showNotice("本次批量识别完成 " + completed + " 张图片。", "success");
    }
  }, [batchActiveService, batchItems, batchMode, codexCliPath, codexCliStatus, ensureLocalReady, localDevice, refreshRecords, runFormulaRecognition, showNotice]);

  const cancelBatch = useCallback(async () => {
    batchCancelledRef.current = true;
    try {
      const taskId = batchTaskIdRef.current ?? setupTaskIdRef.current;
      if (taskId) await cancelRecognition(taskId);
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : "取消批量任务失败。", "error");
    }
  }, [showNotice]);

  const retryBatchItem = useCallback((id: string) => {
    setBatchItems((rows) => rows.map((row) => row.id === id ? {
      ...row, status: "queued", error: "", recordId: undefined, mode: undefined, backend: undefined, serviceName: undefined
    } : row));
  }, []);

  const copyBatchResults = useCallback(async () => {
    const results = batchItems.filter((item) => item.status === "done");
    if (!results.length) return;
    await copyWithNotice(results.map((item) => item.latex).join("\n\n% FormulaSnap result\n\n"), "已复制 " + results.length + " 条 LaTeX 结果。");
  }, [batchItems, copyWithNotice]);

  const onModelAction = useCallback(async (rebuild = false) => {
    setModelBusy(true);
    setModelActionError("");
    try {
      const taskId = makeId();
      setupTaskIdRef.current = taskId;
      setSetupProgress(null);
      const backend = rebuild ? await rebuildLocalEnvironment(taskId) : await setupLocalModel(taskId);
      setLocalDevice(backend === "CUDAExecutionProvider" ? "cuda" : "cpu");
      setModelActionError("");
      await refreshLocalStatus();
      showNotice(backend === "CUDAExecutionProvider"
        ? "CUDA 公式识别已通过真实图片自检。"
        : "CPU 公式识别已通过真实图片自检。", "success");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setModelActionError(message);
      showNotice(message, "error");
      await refreshLocalStatus();
    } finally {
      setModelBusy(false);
    }
  }, [refreshLocalStatus, showNotice]);
  const saveLocalSettingsNow = useCallback(async (next = localSettings) => {
    setLocalSettingsBusy(true);
    setLocalSettingsMessage("");
    try {
      const storageChanged = next.storageDirectory !== localSettings.storageDirectory;
      await saveLocalSettings(next);
      setLocalSettings(next);
      await refreshLocalStatus();
      setLocalSettingsMessage(storageChanged
        ? "本地设置已保存；模型文件已迁移，原隔离运行时保留在旧目录。新位置会在首次识别时配置运行时，旧目录仍可用于回退。"
        : "本地高级设置已保存。下载源变更将用于后续下载。");
    } catch (reason) {
      setLocalSettingsMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLocalSettingsBusy(false);
    }
  }, [localSettings, refreshLocalStatus]);

  const selectLocalStorageDirectory = useCallback(async () => {
    try {
      const directory = await chooseLocalStorageDirectory();
      if (directory) setLocalSettings((current) => ({ ...current, storageDirectory: directory }));
    } catch (reason) {
      setLocalSettingsMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const cancelClearHistory = useCallback(() => setClearHistoryOpen(false), []);
  const cancelApiKeyDelete = useCallback(() => setApiKeyDeleteOpen(false), []);
  const cancelServiceDelete = useCallback(() => setServiceDeleteOpen(false), []);

  const confirmClearHistory = useCallback(async () => {
    try {
      await clearStoredHistory();
      await refreshRecords();
      setCurrentRecordId(null);
      setBatchItems((rows) => rows.map((row) => ({ ...row, recordId: undefined })));
      setClearHistoryOpen(false);
      showNotice("历史记录已清空。", "success");
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : "清空历史记录失败。", "error");
    }
  }, [refreshRecords, showNotice]);
  const removeRecord = useCallback(async (id: string) => {
    try {
      await deleteRecord(id);
      await refreshRecords();
      if (currentRecordId === id) setCurrentRecordId(null);
      setBatchItems((rows) => rows.map((row) => row.recordId === id ? { ...row, recordId: undefined } : row));
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : "删除历史记录失败。", "error");
    }
  }, [currentRecordId, refreshRecords, showNotice]);

  const currentOutputConversion = (() => {
    if (output === "latex") return { value: latex, error: "" };
    if (!latex.trim()) return { value: "", error: "" };
    try {
      if (output === "mathml") return { value: renderFormulaMathml(latex), error: "" };
      if (output === "plain") return { value: renderPlainFormula(latex), error: "" };
      return { value: "", error: "" };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "转换失败，请检查 LaTeX 语法。";
      return { value: "", error: output === "mathml" ? "MathML 转换失败：" + message : message };
    }
  })();
  const currentWordConversionError = (() => {
    if (output !== "word" || !latex.trim()) return "";
    try {
      renderFormulaOmml(latex);
      return "";
    } catch (reason) {
      return reason instanceof Error ? reason.message : "Word 转换失败，请检查 LaTeX 语法。";
    }
  })();
  return (
    <div className={"app-shell " + (customWindowFrame ? "custom-window-frame" : "native-window-frame")} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { void addBrowserDrop(event); }}>

      <input
        ref={fileInputRef}
        className="file-input-hidden"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff"
        onChange={(event) => { if (event.currentTarget.files) void handleInputFiles(event.currentTarget.files); }}
      />
      <header className="desktop-toolbar" aria-label="窗口标题栏">
        <div className="toolbar-drag-region" data-tauri-drag-region aria-hidden="true" />
        {modelBusy && setupProgress && <span className="toolbar-progress" role="status">{setupProgress.message}</span>}
        {customWindowFrame && <>
          <button className={"toolbar-pin" + (pinned ? " active" : "")} aria-label={pinned ? "取消窗口置顶" : "窗口置顶"} title={pinned ? "取消置顶" : "置顶"} aria-pressed={pinned} onClick={() => { if (!isDesktop()) return; const next = !pinned; setPinned(next); void getCurrentWindow().setAlwaysOnTop(next); }}><Pin size={15} /></button>
          <div className="window-controls" aria-label="窗口控制">
            <button aria-label="最小化" title="最小化" onClick={() => { if (isDesktop()) void getCurrentWindow().minimize(); }}><Minus size={15} /></button>
            <button aria-label="最大化或还原" title="最大化或还原" onClick={() => { if (isDesktop()) void getCurrentWindow().toggleMaximize(); }}><Square size={12} strokeWidth={1.6} /></button>
            <button className="window-close" aria-label="关闭窗口" title="关闭" onClick={() => { if (isDesktop()) void getCurrentWindow().close(); }}><X size={16} strokeWidth={1.7} /></button>
          </div>
        </>}
      </header>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">Σ</div>
          <div className="brand-copy"><strong>FormulaSnap</strong><span>让公式触手可得</span></div>
        </div>
        <nav className="nav-list" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.page} className={"nav-item " + (page === item.page ? "active" : "")} onClick={() => setPage(item.page)}>
                <Icon size={21} strokeWidth={2.1} /><span>{item.label}</span>
                {item.shortcut && <small>{item.shortcut}</small>}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot"><span className="privacy-dot" /><span>{mode === "local" ? "本地处理；图片仅留在此设备" : mode === "codex" ? "Codex CLI 本机启动；识别走云端" : "图片仅发送至当前 API 服务"}</span></div>
      </aside>

      <main className="app-main">
        {page === "home" && batchReturnItemId && <div className="batch-return-banner"><button className="link-button" onClick={returnToBatch}><ChevronRight size={15} className="back-chevron" />返回批量识别</button><span>已载入对应图片、源码和识别来源</span></div>}
        {page === "home" && (
          <div className="home-layout">
            <section className="center-column">
              <header className="hero-head">
                <h1>公式识别 <span>工作台</span></h1>
                <p>导入公式图像，识别并导出可编辑公式</p>
              </header>

              <div className="import-actions">
                <button className="import-card primary" onClick={() => void captureDesktop()}>
                  <ScanLine size={28} /><span><strong>截图识别</strong><small>Ctrl + Shift + A</small></span>
                </button>
                <button className="import-card" disabled={clipboardBusy} onClick={() => void pasteImage()}>
                  {clipboardBusy ? <LoaderCircle size={27} className="spin" /> : <Clipboard size={27} />}
                  <span><strong>粘贴图片</strong><small>Ctrl + V</small></span>
                </button>
                <button className="import-card" onClick={() => void chooseFiles(false)}>
                  <FolderOpen size={28} /><span><strong>打开图片</strong><small>支持 PNG / JPG / WebP</small></span>
                </button>
              </div>

              <section className="image-card panel">
                <div className={"image-stage " + (isSelecting ? "selecting" : "")}>
                  {!image && (
                    <button className="empty-drop" onClick={() => void chooseFiles(false)}>
                      <span className="empty-icon"><ImageIcon size={28} /></span>
                      <strong>拖入公式图片，或点击打开</strong>
                      <small>也可以从剪贴板粘贴截图</small>
                    </button>
                  )}
                  {image && (
                    <div className="image-viewport">
                      <div className="zoom-tools">
                        <button aria-label="缩小" onClick={() => setZoom((value) => Math.max(50, value - 10))}><ZoomOut size={17} /></button>
                        <span>{zoom}%</span>
                        <button aria-label="放大" onClick={() => setZoom((value) => Math.min(200, value + 10))}><ZoomIn size={17} /></button>
                        <button aria-label="适合窗口" onClick={() => setZoom(100)}><Maximize2 size={17} /></button>
                      </div>
                      <div className="image-stage-inner" style={{ transform: "scale(" + zoom / 100 + ")" }}>
                        <img
                          ref={imageRef}
                          className="formula-image"
                          src={image.url}
                          alt={image.name}
                          onPointerDown={handleSelectionDown}
                          onPointerMove={handleSelectionMove}
                          onPointerUp={handleSelectionUp}
                        />
                        {selection && (
                          <div className="selection-outline" style={{
                            left: (selection.x * 100) + "%", top: (selection.y * 100) + "%",
                            width: (selection.width * 100) + "%", height: (selection.height * 100) + "%"
                          }} />
                        )}
                      </div>
                      <div className="image-name">{image.name}</div>
                    </div>
                  )}
                </div>
                <div className="image-tools">
                  <button className={isSelecting ? "selected" : ""} disabled={!image} onClick={() => {
                    setIsSelecting((value) => !value);
                    setSelection(null);
                  }}><Crop size={17} />{selection ? "重新选择" : "选择区域"}</button>
                  {selection && <button className="tool-apply" onClick={() => void cropSelection()}>应用选区</button>}
                  <button disabled={!image} onClick={() => void changeImage("rotate")}><RotateCcw size={17} />旋转</button>
                  <button disabled={!image} onClick={() => void changeImage("sharpen")}><Sparkles size={17} />增强清晰度</button>
                  <button disabled={!image} onClick={() => void changeImage("background")}><Layers size={17} />去背景</button>
                  <span className="tool-divider" />
                  <button disabled={!image} className="delete-tool" onClick={() => {
                    setImage(null); setLatex(""); setStatus("idle"); setError("");
                    setSelection(null); setCurrentRecordId(null);
                  }}><Trash2 size={17} />清除</button>
                  {image && image.url !== image.originalUrl && (
                    <button className="restore-tool" onClick={restoreOriginal}><RotateCw size={16} />恢复原图</button>
                  )}
                  {image && !selection && <button className="margin-tool" onClick={() => void trimCurrentImage()}><Eraser size={16} />裁去白边</button>}
                </div>
                <div className="recognition-trigger">
                  {status === "processing" ? (
                    <button className="action-primary cancel-button" onClick={() => void cancelCurrent()}><Square size={16} />取消识别</button>
                  ) : (
                    <button className="action-primary" disabled={!image || isBusy || modelBusy} onClick={() => void recognizeCurrent()}>
                      {status === "error" ? <RotateCw size={17} /> : <Clipboard size={17} />}
                      {status === "error" ? "重试识别" : "开始识别"}
                      <span className="action-mode">{mode === "online" ? activeService.name : mode === "codex" ? "Codex CLI · 云端服务" : "本地 CPU/GPU"}</span>
                    </button>
                  )}
                </div>
              </section>

              <section className="result-card panel">
                <div className="result-heading">
                  <div className="result-title"><h2>识别结果</h2><StatusPill status={status} />{resultSource && <small className="result-source">{resultSource.serviceName}{resultSource.backend ? " · " + resultSource.backend : ""}</small>}</div>
                  {elapsed !== null && <span className="elapsed"><Clock3 size={15} />耗时 {elapsed.toFixed(1)} 秒</span>}
                </div>
                <div className="result-tabs" role="tablist" aria-label="输出格式">
                  {outputOptions.map((option) => (
                    <button key={option.value} role="tab" aria-selected={output === option.value}
                      className={output === option.value ? "selected" : ""}
                      onClick={() => setOutput(option.value)}>{option.label}</button>
                  ))}
                </div>
                {output === "latex" && (
                  <div className="latex-editor-wrap">
                    <textarea className="latex-editor" aria-label="编辑 LaTeX 源码"
                      value={latex} onChange={(event) => editLatex(event.target.value)}
                      placeholder={image ? "点击“开始识别”后，LaTeX 源码会显示在这里；也可以直接输入。" : "识别结果会在这里显示"}
                      spellCheck={false} />
                    <button className="copy-source" disabled={!latex} aria-label="复制 LaTeX"
                      onClick={() => void copyWithNotice(latex, "已复制 LaTeX。")}><Copy size={17} /></button>
                  </div>
                )}
                {output !== "latex" && output !== "word" && (
                  currentOutputConversion.error
                    ? <div className="inline-error format-conversion-error" role="alert"><AlertCircle size={15} /><span>{currentOutputConversion.error}</span></div>
                    : <pre className="output-code">{currentOutputConversion.value || "识别或编辑 LaTeX 后，这里会显示转换结果。"}</pre>
                )}
                {output === "word" && (
                  <>
                    <div className="word-output">
                      <div className="word-mark">W</div>
                      <div><strong>{currentWordConversionError ? "Word 公式暂不能转换" : "可编辑的 Word 公式"}</strong><small>导出 DOCX，公式以 Office Math（OMML）对象写入。</small></div>
                    </div>
                    {currentWordConversionError && <div className="inline-error format-conversion-error" role="alert"><AlertCircle size={15} /><span>{currentWordConversionError}</span></div>}
                  </>
                )}

                <div className="result-actions">
                  <button className="action-secondary" disabled={!latex || !renderedPreview} onClick={() => void copyImage()}><ImageIcon size={17} />复制为图片</button>
                  {output === "word" ? (
                    <button className="action-secondary" disabled={!latex} onClick={() => void exportWord()}><span className="word-mini">W</span>导出可编辑 DOCX</button>
                  ) : (
                    <button className="action-secondary" disabled={!latex} onClick={() => void copySelectedOutput()}><Copy size={17} />复制 {formatLabel(output)}</button>
                  )}

                </div>

                <div className="preview-box">
                  <div className="preview-label"><span>渲染预览</span><small>编辑源码时实时更新</small></div>
                  {latex.trim() ? (
                    renderedPreview ? (
                      <div ref={previewRef} className="formula-preview" dangerouslySetInnerHTML={{ __html: renderedPreview }} />
                    ) : (
                      <div className="preview-error"><AlertCircle size={17} />公式语法暂时无法预览；源码仍保留，可继续编辑。</div>
                    )
                  ) : (
                    <div className="preview-empty">{image ? "识别后会在这里预览公式。" : "导入公式图片后，识别结果与预览会显示在这里。"}</div>
                  )}
                </div>
                {error && <div className={"inline-error " + (status === "cancelled" ? "muted" : "")}><AlertCircle size={15} />{error}</div>}
              </section>
            </section>

            <aside className="right-column">
              <section className="side-panel output-panel">
                <div className="panel-heading"><div><Sparkles size={17} /><h2>输出格式</h2></div><button title="打开设置" onClick={() => setPage("settings")}><Settings2 size={17} /></button></div>
                <div className="format-grid">
                  {outputOptions.map((option) => {
                    const Icon = option.icon;
                    return (
                      <button key={option.value} aria-pressed={output === option.value} className={"format-option " + (output === option.value ? "active" : "")}
                        onClick={() => setOutput(option.value)}>
                        {option.value === "word" ? <span className="word-mark small">W</span> : <Icon size={23} />}
                        <span><strong>{option.label}</strong><small>{option.sub}</small></span>
                      </button>
                    );
                  })}
                </div>
                <div className="panel-rule" />
                <h3 className="side-section-title">识别设置</h3>
                <div className="setting-row"><span>识别引擎</span>
                  <SelectMenu ariaLabel="识别引擎" value={mode}
                    options={[{ value: "online", label: "在线 · " + activeService.name }, { value: "local", label: "本地 · RapidLaTeXOCR" }, { value: "codex", label: "Codex CLI · 已登录账号" }]}
                    onChange={(next) => setMode(next as RecognitionMode)} />
                </div>
                {mode === "online" && <div className="setting-row"><span>API 服务</span>
                  <SelectMenu ariaLabel="API 服务" value={serviceId}
                    options={services.map((service) => ({ value: service.id, label: service.name + (service.hasKey ? "" : " · 未配置密钥") }))}
                    onChange={(next) => {
                      setServiceId(next);
                      const found = services.find((item) => item.id === next);
                      if (found) setServiceDraft(found);
                    }} />
                </div>}
                <label className="switch-row">
                  <span><strong>自动裁去四周空白</strong><small>按深色像素裁边；不会定位页面中的单个公式。</small></span>
                  <input type="checkbox" checked={autoTrim} onChange={(event) => setAutoTrim(event.target.checked)} />
                </label>
                {mode === "local" && <div className="engine-state"><Cpu size={15} />{localStatus?.activeBackend ? "已就绪 · " + localStatus.activeBackend : localStatus?.runtimeInstalled ? "下次识别时自动加载" : "预置模型；首次识别自动配置"}</div>}
                {mode === "local" && modelBusy && setupProgress && <div className="local-setup-inline" role="status">{setupProgress.message}</div>}{mode === "codex" && <div className="engine-state"><Sparkles size={15} />本机 Codex CLI 发起请求 · 使用 Codex 云端服务</div>}
              </section>

              <section className="side-panel recent-panel">
                <div className="panel-heading">
                  <div><Clock3 size={17} /><h2>最近记录</h2></div>
                  <button className="link-button" onClick={() => setPage("history")}>查看全部 <ChevronRight size={15} /></button>
                </div>
                {!records.length ? (
                  <div className="recent-empty"><span><HistoryIcon size={22} /></span><strong>还没有识别记录</strong><small>识别成功后，结果会保存在这里。</small></div>
                ) : (
                  <div className="recent-list">
                    {records.slice(0, 4).map((record) => (
                      <div className="recent-item" key={record.id}>
                        <button className="recent-thumb" onClick={() => void selectRecord(record)}><img src={record.imageDataUrl} alt="" /></button>
                        <button className="recent-copy" onClick={() => void selectRecord(record)}>
                          <span>{record.latex.slice(0, 52) || "公式结果"}</span>
                          <small>{new Date(record.createdAt).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · {record.serviceName}</small>
                        </button>
                        <button className="icon-quiet" title="复制 LaTeX" onClick={() => void copyWithNotice(record.latex, "已复制历史结果。")}><Copy size={17} /></button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <div className="local-privacy-note"><ShieldCheck size={16} /><span>{mode === "codex" ? "Codex CLI 在本机启动，公式图片由 Codex 云端服务处理；这不是离线识别。" : mode === "online" ? "在线模式会将图片发送给当前选中的 API 服务。" : "本地模式在模型加载后可离线识别；图片留在此设备。"}</span></div>
            </aside>
          </div>
        )}

        {page === "batch" && (
          <section className="workspace-page">
            <header className="page-heading"><div><span className="eyebrow">MULTI IMAGE</span><h1>批量识别</h1><p>顺序处理图片，单项失败不会影响其他结果。</p></div>
              <div className="heading-actions"><button className="action-secondary" disabled={batchBusy} onClick={() => void chooseFiles(true)}><Plus size={17} />添加图片</button>
                {batchBusy ? <button className="action-primary" onClick={() => void cancelBatch()}><Square size={15} />取消队列</button> : <button className="action-primary" disabled={!preferencesLoaded || batchMode === "codex" && codexChecking || !batchItems.some((item) => item.status === "queued" || item.status === "failed" || item.status === "cancelled")} onClick={() => void startBatch()}><Play size={16} />开始处理</button>}
              </div>
            </header>
            <section className="batch-engine-panel" aria-label="批量识别引擎">
              <div className="batch-engine-fields">
                <label className="batch-engine-field"><span>识别引擎</span>
                  <SelectMenu ariaLabel="批量识别引擎" value={batchMode} disabled={batchBusy || !preferencesLoaded}
                    options={[
                      { value: "local", label: "本地模型 · RapidLaTeXOCR" },
                      { value: "online", label: "API 服务" },
                      { value: "codex", label: "Codex CLI" }
                    ]}
                    onChange={(next) => setBatchMode(next as RecognitionMode)} />
                </label>
                {batchMode === "online" && <>
                  <label className="batch-engine-field"><span>API 服务</span>
                    <SelectMenu ariaLabel="批量 API 服务" value={batchActiveService.id} disabled={batchBusy || !preferencesLoaded}
                      options={services.map((service) => ({ value: service.id, label: service.name + (service.hasKey ? "" : " · 未配置 Key") }))}
                      onChange={setBatchServiceId} />
                  </label>
                  <div className="batch-engine-status">
                    <strong>{batchActiveService.name} · {batchActiveService.model}</strong>
                    <span className={batchActiveService.hasKey ? "ready" : "unready"}>{batchActiveService.hasKey ? "密钥已保存 · 首次识别直接请求图片" : "尚未配置 API Key"}</span>
                    {!batchActiveService.hasKey && <button className="link-button" type="button" onClick={() => {
                      setServiceId(batchActiveService.id);
                      setServiceDraft(batchActiveService);
                      setPage("settings");
                    }}>去设置 API 服务</button>}
                  </div>
                </>}
              </div>
              {batchMode === "local" && <div className="batch-engine-status">
                <strong>{localStatus?.modelName || "RapidLaTeXOCR"} · {localStatus?.selectedDevice === "cuda" ? "NVIDIA CUDA" : "CPU"}</strong>
                <span className={localConfigured ? "ready" : "unready"}>{localConfigured
                  ? localStatus?.workerRunning ? "环境就绪 · 工作进程已加载" : "环境已配置 · 处理前自动加载"
                  : localStatus?.statusReadable === false ? "环境状态读取失败"
                    : localStatus?.modelInstalled ? "首次批量识别时自动准备隔离环境" : "模型或运行时尚未就绪"}</span>
                {!localConfigured && <button className="link-button" type="button" onClick={() => setPage("settings")}>本地模型设置</button>}
              </div>}
              {batchMode === "codex" && <div className="batch-engine-status">
                <strong>Codex CLI · 模型：使用 CLI 当前默认配置</strong>
                <span className={codexCliStatus?.status === "ready" ? "ready" : "unready"}>
                  {codexChecking ? "正在检查 CLI 登录状态…" : codexCliStatus
                    ? codexCliStatus.status === "ready"
                      ? "已登录" + (codexCliStatus.version ? " · " + codexCliStatus.version : "")
                      : codexCliStatus.message
                    : "尚未检查 CLI 登录状态"}
                </span>
                <button className="link-button" type="button" disabled={codexChecking || batchBusy} onClick={() => void checkCodexConnection()}>
                  {codexChecking ? "检查中…" : "检查登录"}
                </button>
                <button className="link-button" type="button" onClick={() => setPage("settings")}>CLI 设置与登录说明</button>
              </div>}
              {batchBusy && <p className="batch-engine-lock" role="status"><ShieldCheck size={14} />本轮引擎与服务配置已固定；队列处理结束后可更改。</p>}
              {batchBusy && (batchMode === "local" && !localConfigured || setupProgress?.status === "running") && <div className="batch-setup-progress" role="status" aria-live="polite">
                <div className={setupProgress?.percent === null || !setupProgress ? "local-setup-track indeterminate" : "local-setup-track"}>
                  <span style={setupProgress?.percent == null ? undefined : { width: setupProgress.percent + "%" }} />
                </div>
                <span>{setupProgress ? setupProgress.message : "正在准备本地公式识别环境…"}</span>
              </div>}
            </section>
            <div className="batch-toolbar"><span>{batchItems.length} 张图片 · {batchItems.filter((item) => item.status === "done").length} 张完成</span><button className="link-button" disabled={!batchItems.some((item) => item.status === "done")} onClick={() => void copyBatchResults()}><Copy size={15} />复制全部 LaTeX</button></div>
            {!batchItems.length ? <div className="page-empty"><div className="empty-icon"><Layers size={28} /></div><strong>队列还是空的</strong><span>添加多张图片，按顺序识别并保留每张的独立状态。</span><button className="action-primary" onClick={() => void chooseFiles(true)}><FolderOpen size={16} />选择图片</button></div> :
              <div className="batch-list" ref={batchListRef}>{batchItems.map((item, index) => {
                const canOpen = item.status === "done";
                const openResult = () => { if (canOpen) void openBatchResult(item); };
                return (
                  <article className="batch-card" key={item.id}>
                    {canOpen ? <button className="batch-open-image" type="button" aria-label={"查看识别结果：" + item.title} onClick={openResult}><img src={item.imageDataUrl} alt="" /></button> : <img src={item.imageDataUrl} alt={item.title} />}
                    <div className="batch-card-main">
                      <div className="batch-title">
                        {canOpen ? <button className="batch-title-open" type="button" onClick={openResult}>{index + 1}. {item.title}</button> : <strong>{index + 1}. {item.title}</strong>}
                        <span className={'queue-status ' + item.status}>{item.status === "queued" ? "等待中" : item.status === "processing" ? "识别中" : item.status === "done" ? "已完成" : item.status === "cancelled" ? "已取消" : "失败"}</span>
                      </div>
                      {canOpen ? <>
                        <BatchFormulaPreview latex={item.latex} onOpen={openResult} />
                        <small className="batch-source-meta">实际来源：{batchEngineSourceLabel(item.mode, item.serviceName, item.backend)}</small>
                      </> : <>
                        {item.error ? <p className="batch-error">{item.error}</p> : <p>{item.status === "processing" ? "正在调用所选引擎…" : "等待使用上方选择的引擎处理"}</p>}
                        {item.mode && <small className="batch-source-meta">本次引擎：{batchEngineSourceLabel(item.mode, item.serviceName, item.backend)}</small>}
                      </>}
                    </div>
                    <div className="batch-card-actions">
                      {canOpen && <button className="icon-quiet" type="button" aria-label="查看识别结果" title="查看识别结果" onClick={openResult}><Eye size={17} /></button>}
                      {item.status === "done" && <button className="icon-quiet" type="button" aria-label="复制 LaTeX" title="复制 LaTeX" onClick={() => void copyWithNotice(item.latex, "已复制单项 LaTeX。")}><Copy size={17} /></button>}
                      {(item.status === "failed" || item.status === "cancelled") && <button className="icon-quiet" type="button" aria-label="重试" title="重试（使用上方当前选择的引擎）" disabled={batchBusy} onClick={() => retryBatchItem(item.id)}><RotateCw size={17} /></button>}
                      <button className="icon-quiet danger" type="button" aria-label="移出队列" title="移出队列" disabled={batchBusy || item.status === "processing"} onClick={() => setBatchItems((rows) => rows.filter((row) => row.id !== item.id))}><Trash2 size={17} /></button>
                    </div>
                  </article>
                );
              })}</div>}
          </section>
        )}

        {page === "history" && (
          <section className="workspace-page">
            <header className="page-heading"><div><span className="eyebrow">LOCAL LIBRARY</span><h1>历史记录</h1><p>识别图片与编辑后的 LaTeX 保存在本机浏览器数据库中。</p></div><button className="action-secondary" disabled={!records.length} onClick={() => setClearHistoryOpen(true)}><Trash2 size={16} />清空记录</button></header>
            <label className="history-search"><Search size={18} /><input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜索标题或 LaTeX 源码" /></label>
            {!historyMatches.length ? <div className="page-empty"><div className="empty-icon"><HistoryIcon size={28} /></div><strong>{records.length ? "没有匹配记录" : "还没有识别记录"}</strong><span>{records.length ? "换一个搜索词试试。" : "完成一次真实识别后，记录会显示在这里。"}</span></div> :
              <div className="history-grid">{historyMatches.map((record) => <article className="history-card" key={record.id}>
                <button className="history-image" onClick={() => void selectRecord(record)}><img src={record.imageDataUrl} alt={record.title} /></button>
                <div className="history-info"><button className="history-title" onClick={() => void selectRecord(record)}>{record.title}</button><code>{record.latex}</code><small>{new Date(record.createdAt).toLocaleString("zh-CN")} · {record.serviceName}{record.backend ? " · " + record.backend : ""}</small></div>
                <div className="history-actions"><button className="icon-quiet" title="复制 LaTeX" onClick={() => void copyWithNotice(record.latex, "已复制 LaTeX。")}><Copy size={17} /></button><button className="icon-quiet" title="重新编辑" onClick={() => void selectRecord(record)}><Eye size={17} /></button><button className="icon-quiet danger" title="删除" onClick={() => void removeRecord(record.id)}><Trash2 size={17} /></button></div>
              </article>)}</div>}
          </section>
        )}

        {page === "settings" && (
          <section className="workspace-page settings-page">
            <header className="page-heading"><div><span className="eyebrow">PREFERENCES</span><h1>设置</h1><p>识别服务、本地引擎与图片预处理。</p></div></header>
            <section className="settings-card"><div className="settings-card-heading"><div className="settings-icon"><Globe2 size={19} /></div><div><h2>在线 API 服务</h2><p>图片会直接发送给你选择的服务；密钥通过系统凭据库保存。</p></div></div>
              <div className="form-grid"><div className="field"><span>服务配置</span>
                  <SelectMenu ariaLabel="服务配置" value={serviceDraft.id}
                    options={services.map((service) => ({ value: service.id, label: service.name + (service.hasKey ? "" : " · 未配置密钥") }))}
                    onChange={(next) => {
                      const found = services.find((row) => row.id === next);
                      if (found) { setServiceDraft(found); setServiceId(found.id); setApiKeyDraft(""); setServiceTestState(""); }
                    }} />
                </div><div className="field field-button"><span>新增配置</span><button className="action-secondary" onClick={createCustomService}><Plus size={16} />添加视觉 API</button></div>
                <label className="field"><span>服务名称</span><input value={serviceDraft.name} onChange={(event) => setServiceDraft({ ...serviceDraft, name: event.target.value })} placeholder="例如：DeepSeek" /></label>
                <label className="field"><span>API 地址</span><input value={serviceDraft.endpoint} onChange={(event) => setServiceDraft({ ...serviceDraft, endpoint: event.target.value, visionVerified: false, lastImageRequestAt: undefined, lastImageRequestOk: undefined, lastImageRequestError: undefined })} placeholder="https://api.example.com/v1/chat/completions" /></label>
                <label className="field"><span>模型名称</span><input value={serviceDraft.model} onChange={(event) => setServiceDraft({ ...serviceDraft, model: event.target.value, visionVerified: false, lastImageRequestAt: undefined, lastImageRequestOk: undefined, lastImageRequestError: undefined })} placeholder="视觉模型 ID" /></label>
                <div className="field"><span>接口类型</span>
                  <SelectMenu ariaLabel="接口类型" value={serviceDraft.adapter}
                    options={[{ value: "deepseek-vision", label: "DeepSeek 视觉 API" }, { value: "openai-compatible-vision", label: "OpenAI 兼容视觉 API" }]}
                    onChange={(next) => setServiceDraft({ ...serviceDraft, adapter: next as ApiService["adapter"], visionVerified: false, lastImageRequestAt: undefined, lastImageRequestOk: undefined, lastImageRequestError: undefined })} />
                </div>
                <label className="field"><span>API Key {credentialWarning ? "· 状态无法读取" : serviceDraft.hasKey ? "· 已安全保存" : "· 尚未设置"}</span><input type="password" autoComplete="new-password" value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} placeholder={credentialWarning ? "状态无法读取；留空保留现有 Key" : serviceDraft.hasKey ? "已保存在 Windows 凭据库；留空保留" : "仅写入 Windows 凭据库"} /></label>
                <div className="field field-button"><span>密钥管理</span><button className="action-secondary" disabled={!serviceDraft.hasKey} onClick={() => setApiKeyDeleteOpen(true)}><Trash2 size={15} />删除密钥</button></div>
              </div>
              {credentialWarning && <div className="inline-error credential-warning" role="status"><AlertCircle size={15} />{credentialWarning} 新输入的 Key 仍只写入 Windows 凭据库。</div>}
              <p className="settings-note"><ShieldCheck size={15} />密钥保存在 Windows 凭据库；普通设置数据库只保存服务 ID 和识别偏好。</p>
              <p className="settings-note"><ShieldCheck size={15} />连接测试只检查 API 响应；首次实际识别会直接调用图像接口；测试连接和图片诊断都是可选项。</p>
              <div className="settings-actions"><button className="action-primary" disabled={modelBusy} onClick={() => void persistService()}><Save size={16} />保存服务</button><button className="action-secondary" disabled={modelBusy || !serviceDraft.hasKey && !credentialWarning && !apiKeyDraft.trim()} onClick={() => void testService(false)}><Globe2 size={16} />测试连接</button><button className="action-secondary" disabled={modelBusy || !image} onClick={() => void testService(true)}><ImageIcon size={16} />诊断图片请求（可选）</button>{serviceDraft.id !== defaultService.id && <button className="action-secondary danger-text" onClick={() => setServiceDeleteOpen(true)}><Trash2 size={16} />删除配置</button>}</div>
              {serviceTestState && <div className="test-result">{serviceTestState}</div>}
              <div className="verified-state"><span className={serviceDraft.hasKey ? "state-dot good" : "state-dot"} />{isBuiltInDeepSeekVisionPreset(serviceDraft) ? "内置 DeepSeek 视觉预设 · deepseek-flash" : "自定义 API 服务"} · {serviceDraft.hasKey ? "API Key 已保存" : "尚未保存 API Key"}<small>{serviceDraft.lastImageRequestAt ? "最近图片请求：" + (serviceDraft.lastImageRequestOk ? "成功" : "失败") + " · " + new Date(serviceDraft.lastImageRequestAt).toLocaleString("zh-CN") + (serviceDraft.lastImageRequestError ? " · " + serviceDraft.lastImageRequestError : "") : "尚无真实图片识别请求；保存 Key 后可直接识别。"}</small></div>
            </section>

            <section className="settings-card codex-card">
              <div className="settings-card-heading"><div className="settings-icon"><Sparkles size={19} /></div><div><h2>Codex CLI（本机已登录账号）</h2><p>由 FormulaSnap 在后台启动本机 Codex CLI；公式转写请求仍由 Codex 云端服务处理。</p></div></div>
              <label className="field codex-path-field"><span>Codex CLI 路径（留空则从 PATH 查找原生程序）</span><div className="codex-path-row"><input value={codexCliPath} onChange={(event) => { setCodexCliPath(event.target.value); setCodexCliStatus(null); setCodexLastImageRequest(null); }} placeholder="例如 C:\\Users\\…\\codex.exe" /><button className="action-secondary" type="button" onClick={() => void chooseCodexExecutable()}>选择 codex.exe</button></div></label>
              <div className="settings-actions"><button className="action-secondary" type="button" disabled={codexChecking} onClick={() => void checkCodexConnection()}>{codexChecking ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}检查 CLI 与登录状态</button>{mode !== "codex" && <button className="action-primary" type="button" onClick={() => setMode("codex")}>设为识别引擎</button>}</div>
              {codexCliStatus && <div className={'codex-status ' + codexCliStatus.status} role="status"><span>{codexCliStatus.message}</span>{codexCliStatus.version && <small>{codexCliStatus.version}{codexCliStatus.executable ? " · " + codexCliStatus.executable : ""}</small>}</div>}
              {codexLastImageRequest && <div className={'codex-request-state ' + (codexLastImageRequest.ok ? "success" : "failure")} role="status"><strong>{codexLastImageRequest.ok ? "最近公式图片请求成功" : "最近公式图片请求失败"}</strong><span>{new Date(codexLastImageRequest.at).toLocaleString("zh-CN")}{codexLastImageRequest.error ? " · " + codexLastImageRequest.error : " · 已收到结构化公式结果"}</span></div>}
              <p className="settings-note"><ShieldCheck size={15} />使用官方 codex login status 检查状态。FormulaSnap 不读取 auth 文件或进程令牌；实际图片请求完成后才确认识别能力。使用 CLI 当前默认模型，不要求单独 API Key。</p>
            </section>
            <section className="settings-card model-card">
              <div className="settings-card-heading">
                <div className="settings-icon"><Cpu size={19} /></div>
                <div><h2>本地公式识别</h2><p>公式 OCR 权重已随安装包预置，首次识别会自动配置隔离运行环境。</p></div>
                <span className={'model-state-pill ' + (localStatus?.modelInstalled ? "ready" : "")}>{localStatus?.modelInstalled ? "模型已内置" : localStatus ? "检查状态" : "正在检查"}</span>
              </div>
              <div className="model-facts">
                <div><small>模型权重</small><strong>{localStatus?.modelInstalled ? (localStatus.modelBytes / 1024 / 1024).toFixed(0) + " MiB · 已校验" : "安装包中未找到"}</strong></div>
                <div><small>隔离运行时</small><strong>{localStatus?.runtimeManifestValid ? "已验证 · 重启可复用" : localStatus?.runtimeInstalled ? "已安装，待验证" : localStatus?.statusReadable === false ? "状态读取失败" : "首次识别时自动配置"}</strong></div>
                <div><small>工作进程</small><strong>{localStatus?.workerRunning ? "已运行" : localConfigured ? "识别时自动加载" : "未加载"}</strong></div>
                <div><small>实际后端</small><strong>{localStatus?.activeBackend ?? (localStatus?.runtimeManifestValid ? (localStatus.selectedDevice === "cuda" ? "CUDAExecutionProvider · 已验证" : "CPUExecutionProvider · 已验证") : "尚未启动")}</strong></div>
              </div>
              {(modelActionError || localStatus?.runtimeError || localStatus?.statusReadable === false && localStatus.error) && <div className="inline-error model-action-error" role="alert"><AlertCircle size={15} /><span>{modelActionError || localStatus?.runtimeError || localStatus?.error}</span>{!localConfigured && <button className="link-button" disabled={modelBusy || localStatus?.statusReadable === false} onClick={() => void onModelAction()}>重试</button>}</div>}
              {credentialWarning && <p className="settings-note"><ShieldCheck size={15} />在线 Key 状态读取失败；本地公式识别不依赖 API Key。</p>}
              {modelBusy && setupProgress?.status === "running" && <div className="local-setup-progress" role="status" aria-live="polite">
                <div className={'local-setup-track ' + (setupProgress.percent === null ? "indeterminate" : "")}>
                  <span style={setupProgress.percent === null ? undefined : { width: setupProgress.percent + "%" }} />
                </div>
                <span>{localProgressLabel(setupProgress, Math.max(0, progressClock - setupEventReceivedAt))}</span>
              </div>}
              {localConfigured && <div className="active-backend"><CheckCircle2 size={16} />环境自检和真实公式图片识别已通过；{localStatus?.workerRunning ? "工作进程已加载。" : "下次识别时自动加载工作进程。"}</div>}
              {!localConfigured && <div className="settings-actions model-actions">
                <button className="action-primary" disabled={modelBusy || !localStatus?.statusReadable} onClick={() => void onModelAction()}>
                  {modelBusy ? <LoaderCircle size={16} className="spin" /> : <Cpu size={16} />}
                  {modelBusy ? "正在配置与自检" : localStatus?.statusReadable === false ? "无法读取本地环境状态" : modelActionError || localStatus?.runtimeError ? "重试本地识别配置" : "一键配置本地识别"}
                </button>
                {mode !== "local" && <button className="action-secondary" onClick={() => setMode("local")}>设为默认识别</button>}
                <button className="action-secondary" aria-expanded={localAdvancedOpen} onClick={() => setLocalAdvancedOpen((value) => !value)}><Settings2 size={16} />高级设置</button>
              </div>}
              {localConfigured && <div className="settings-actions model-actions local-advanced-actions">
                <button className="action-secondary" aria-expanded={localAdvancedOpen} onClick={() => setLocalAdvancedOpen((value) => !value)}><Settings2 size={16} />{localAdvancedOpen ? "收起高级设置" : "高级设置"}</button>
                {mode !== "local" && <button className="action-secondary" onClick={() => setMode("local")}>设为默认识别</button>}
              </div>}
              {localAdvancedOpen && <div className="local-advanced-panel">
                <strong>下载源与存储位置</strong>
                <p>地区线索只使用系统国家/区域设置；不读取精确位置、界面语言或时区来判断地区。当前检测：{localSettings.detectedRegion === "mainland" ? "中国大陆系统区域" : localSettings.detectedRegion === "non-mainland" ? "非大陆系统区域" : "未知，先尝试官方源"}。</p>
                <label className="field"><span>下载源策略</span>
                  <SelectMenu ariaLabel="本地下载源策略" value={localSettings.sourcePolicy}
                    options={[
                      { value: "auto", label: "自动（大陆镜像优先，自动回退）" },
                      { value: "official", label: "官方源" },
                      { value: "aliyun", label: "阿里云（PyPI）" },
                      { value: "tsinghua", label: "清华镜像" },
                      { value: "custom", label: "自定义源" }
                    ]}
                    onChange={(value) => setLocalSettings((current) => ({ ...current, sourcePolicy: value as LocalSettings["sourcePolicy"] }))} />
                </label>
                <p className="settings-note">已验证覆盖：PyPI 使用阿里/清华 HTTPS 镜像，conda-forge 使用清华镜像；Miniforge 与模型发布物没有已验证的这两家镜像，默认保持官方固定版本并校验 SHA-256，自定义地址也必须通过同一校验。</p>
                {localSettings.sourcePolicy === "custom" && <>
                  <label className="field"><span>自定义 PyPI HTTPS 地址</span><input value={localSettings.customPypiIndex} onChange={(event) => setLocalSettings((current) => ({ ...current, customPypiIndex: event.target.value }))} placeholder="https://…/simple/" /></label>
                  <label className="field"><span>自定义 Conda channel HTTPS 地址</span><input value={localSettings.customCondaChannel} onChange={(event) => setLocalSettings((current) => ({ ...current, customCondaChannel: event.target.value }))} placeholder="https://…/conda-forge/" /></label>
                  <label className="field"><span>自定义 Miniforge 安装器 HTTPS 地址</span><input value={localSettings.customMiniforgeUrl} onChange={(event) => setLocalSettings((current) => ({ ...current, customMiniforgeUrl: event.target.value }))} placeholder="完整固定版本安装器地址" /></label>
                  <label className="field"><span>自定义模型文件 HTTPS 基址</span><input value={localSettings.customModelBaseUrl} onChange={(event) => setLocalSettings((current) => ({ ...current, customModelBaseUrl: event.target.value }))} placeholder="模型文件目录；仍逐文件校验 SHA-256" /></label>
                </>}
                <div className="field field-button"><span>模型与运行环境存储目录</span><div className="storage-actions"><button className="action-secondary" onClick={() => void selectLocalStorageDirectory()}><FolderOpen size={15} />选择目录</button>{localSettings.storageDirectory && <button className="link-button" onClick={() => setLocalSettings((current) => ({ ...current, storageDirectory: "" }))}>恢复默认位置</button>}</div></div>
                <p className="settings-note">新安装默认保存在桌面程序旁的 FormulaSnapData 子目录（Windows 安装默认为当前用户可写位置）。旧版本已有的受管 Python 环境会在原路径继续复用，避免移动 Conda 前缀；改选目录时只复制路径无关的模型文件，旧环境保留，所选位置首次识别时再配置运行时。开发/验收的 FORMULASNAP_DATA_DIR 优先。</p>
                <p className="settings-note">当前模型路径：{localStatus?.modelDirectory || "状态读取后显示"}</p>
                {localSettingsBusy && <div className="local-setup-progress" role="status" aria-live="polite"><div className="local-setup-track indeterminate"><span /></div><span>正在保存设置并安全迁移 FormulaSnap 管理的模型文件…</span></div>}
                {localSettingsMessage && <div className={localSettingsMessage.includes("失败") || localSettingsMessage.includes("不可") ? "inline-error" : "test-result"} role="status">{localSettingsMessage}</div>}
                <div className="settings-actions"><button className="action-primary" disabled={localSettingsBusy} onClick={() => void saveLocalSettingsNow()}>{localSettingsBusy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存高级设置</button></div>
                {localConfigured && <>
                  <div className="panel-rule" />
                  <strong>本地环境管理</strong>
                  <p>重建只会替换 FormulaSnap 自己创建的 Python 与推理环境；公式模型、图片、历史记录、API 密钥和偏好设置会保留。</p>
                  <button className="action-secondary danger-text" disabled={modelBusy} onClick={() => setLocalRebuildConfirmOpen(true)}><RotateCw size={15} />一键重建环境</button>
                </>}
              </div>}
              <div className="model-warning"><AlertCircle size={16} /><span>权重随软件安装，约 171 MiB，不需另行下载。新安装默认把模型、隔离 Python 与推理缓存放在程序旁的 FormulaSnapData；旧版本受管环境保留原路径并持续复用。首次准备运行环境需要联网；程序目录不可写时，可在高级设置选择可写目录。</span></div>
            </section>

            <section className="settings-card"><div className="settings-card-heading"><div className="settings-icon"><ImageIcon size={19} /></div><div><h2>图片处理</h2><p>图像处理会影响送入识别器的图片，原始图片保留，可随时恢复。</p></div></div>
              <label className="switch-row setting-switch"><span><strong>自动裁去四周空白</strong><small>按亮度阈值裁边；不定位或删除公式图片内部内容。</small></span><input type="checkbox" checked={autoTrim} onChange={(event) => setAutoTrim(event.target.checked)} /></label>
              <p className="settings-note"><Sparkles size={15} />“增强清晰度”使用局部对比度处理，“去背景”使用灰度阈值；均不会生成原图中不存在的信息。</p>
            </section>
          </section>
        )}
      </main>

      {clearHistoryOpen && <ConfirmDialog title="清空全部历史记录？" message="此操作会删除 FormulaSnap 中保存的所有识别记录，无法撤销。" confirmLabel="清空记录" onCancel={cancelClearHistory} onConfirm={confirmClearHistory} />}
      {apiKeyDeleteOpen && <ConfirmDialog title="删除这个 API Key？" message="这会从 Windows 系统凭据库中删除当前服务的密钥；服务地址和模型设置会保留。" confirmLabel="删除密钥" onCancel={cancelApiKeyDelete} onConfirm={removeCurrentApiKey} />}
      {serviceDeleteOpen && <ConfirmDialog title="删除这个视觉 API 配置？" message="FormulaSnap 会删除当前服务配置和对应的 Windows 凭据库密钥，此操作无法撤销。" confirmLabel="删除配置" onCancel={cancelServiceDelete} onConfirm={removeCurrentService} />}
      {localRebuildConfirmOpen && <ConfirmDialog title="重建本地识别环境？" message="FormulaSnap 将重建本应用管理的隔离 Python 与推理组件。若重建失败，会恢复当前仍可用的环境；模型权重、图片、历史记录、API 密钥和其他偏好会保留。" confirmLabel="重建环境" onCancel={() => setLocalRebuildConfirmOpen(false)} onConfirm={() => { setLocalRebuildConfirmOpen(false); void onModelAction(true); }} />}
      {captureChoices && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCaptureChoices(null); }}><section ref={captureDialogRef} className="capture-dialog" role="dialog" aria-modal="true" aria-labelledby="capture-title"><div className="panel-heading"><div><Monitor size={18} /><h2 id="capture-title">选择要截取的显示器</h2></div><button className="icon-quiet" onClick={() => setCaptureChoices(null)} aria-label="关闭"><X size={18} /></button></div><p>检测到多个显示器。选取后可在公式画布中重新框选具体区域。</p><div className="capture-list">{captureChoices.map((screen) => <button className="capture-choice" key={screen.id} onClick={() => void addScreenToWorkspace(screen)}><img src={screen.imageDataUrl} alt="" /><span><strong>{screen.name}</strong><small>{screen.width} × {screen.height}</small></span><ChevronRight size={18} /></button>)}</div></section></div>}
      {notice && <div role="status" className={'toast ' + notice.tone}><span>{notice.tone === "success" ? <CheckCircle2 size={17} /> : notice.tone === "error" ? <AlertCircle size={17} /> : <Sparkles size={17} />}</span>{notice.message}<button onClick={() => setNotice(null)} aria-label="关闭通知"><X size={15} /></button></div>}
    </div>
  );
}

export default App;



