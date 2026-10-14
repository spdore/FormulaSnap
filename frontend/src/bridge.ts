import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Image as TauriImage } from "@tauri-apps/api/image";
import { open } from "@tauri-apps/plugin-dialog";
import { readImage, writeImage as writeClipboardImage, writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import type { ApiService, CaptureScreen, CodexCliStatus, LocalModelStatus, LocalRecognitionResult, LocalSettings } from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isDesktop = (): boolean => Boolean(window.__TAURI_INTERNALS__);

export async function pickImagePaths(multiple = false): Promise<string[]> {
  if (!isDesktop()) return [];
  const result = await open({
    multiple,
    title: multiple ? "选择公式图片" : "打开公式图片",
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"] }]
  });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

export async function readImagePath(path: string): Promise<string> {
  if (!isDesktop()) throw new Error("请使用桌面版打开本地图片。");
  return invoke<string>("load_image_from_path", { path });
}

export async function readClipboardFormulaImage(): Promise<string> {
  if (isDesktop()) {
    const image = await readImage();
    try {
      const [rgba, size] = await Promise.all([image.rgba(), image.size()]);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法读取剪贴板图像。");
      context.putImageData(new ImageData(new Uint8ClampedArray(rgba), size.width, size.height), 0, 0);
      return canvas.toDataURL("image/png");
    } finally {
      await image.close();
    }
  }

  const clipboard = navigator.clipboard;
  if (!clipboard?.read) throw new Error("浏览器不允许读取剪贴板图片，请改用“打开图片”。");
  const items = await clipboard.read();
  for (const item of items) {
    const mime = item.types.find((type) => type.startsWith("image/"));
    if (mime) return blobToDataUrl(await item.getType(mime));
  }
  throw new Error("剪贴板中没有图片。");
}

export async function readLocalFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择 PNG、JPEG 或 WebP 图片。");
  return blobToDataUrl(file);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败。"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export async function captureScreens(): Promise<CaptureScreen[]> {
  if (!isDesktop()) throw new Error("系统截图仅在桌面版中可用。");
  return invoke<CaptureScreen[]>("capture_screens");
}

export async function recognizeOnline(taskId: string, imageDataUrl: string, service: ApiService): Promise<string> {
  if (!isDesktop()) throw new Error("请在 FormulaSnap 桌面版中配置 API 并识别图片。");
  return invoke<string>("recognize_online", {
    taskId,
    imageDataUrl,
    service: {
      id: service.id,
      name: service.name,
      endpoint: service.endpoint,
      model: service.model,
      adapter: service.adapter,
      visionVerified: service.visionVerified
    }
  });
}

export async function checkCodexCli(cliPath: string): Promise<CodexCliStatus> {
  if (!isDesktop()) return { status: "check-error", executable: null, version: null, message: "Codex CLI 仅能从 FormulaSnap 桌面版调用。" };
  return invoke<CodexCliStatus>("check_codex_cli", { cliPath: cliPath.trim() || null });
}

export async function recognizeCodex(taskId: string, imageDataUrl: string, cliPath: string): Promise<LocalRecognitionResult> {
  if (!isDesktop()) throw new Error("Codex CLI 识别仅能从 FormulaSnap 桌面版调用。");
  return invoke<LocalRecognitionResult>("recognize_codex", { taskId, imageDataUrl, cliPath: cliPath.trim() || null });
}
export async function cancelRecognition(taskId: string): Promise<void> {
  if (isDesktop()) await invoke("cancel_recognition", { taskId });
}

export async function checkApiKey(serviceId: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return invoke<boolean>("has_api_key", { serviceId });
}

export async function storeApiKey(serviceId: string, apiKey: string): Promise<void> {
  if (!isDesktop()) throw new Error("API Key 只能保存在桌面版系统凭据库中。");
  await invoke("store_api_key", { serviceId, apiKey });
}

export async function deleteApiKey(serviceId: string): Promise<void> {
  if (isDesktop()) await invoke("delete_api_key", { serviceId });
}

export async function testApiService(service: ApiService, imageDataUrl?: string): Promise<string> {
  if (!isDesktop()) throw new Error("服务测试只能从桌面版安全调用。");
  return invoke<string>("test_api_service", {
    service: {
      id: service.id,
      name: service.name,
      endpoint: service.endpoint,
      model: service.model,
      adapter: service.adapter,
      visionVerified: service.visionVerified
    },
    imageDataUrl: imageDataUrl ?? null
  });
}

export async function getLocalSettings(): Promise<LocalSettings> {
  if (!isDesktop()) throw new Error("本地下载设置需要桌面版。");
  return invoke<LocalSettings>("get_local_settings");
}

export async function saveLocalSettings(settings: LocalSettings): Promise<void> {
  if (!isDesktop()) throw new Error("本地下载设置需要桌面版。");
  await invoke("save_local_settings", { settings });
}

export async function chooseLocalStorageDirectory(): Promise<string | null> {
  if (!isDesktop()) return null;
  const result = await open({ directory: true, multiple: false, title: "选择 FormulaSnap 本地模型与运行环境的存储位置" });
  return typeof result === "string" ? result : null;
}

export async function checkLocalModel(): Promise<LocalModelStatus> {
  if (!isDesktop()) {
    return {
      modelName: "RapidLaTeXOCR",
      modelVersion: "v0.0.0 权重",
      modelDirectory: "桌面版应用数据目录",
      modelInstalled: false,
      modelBytes: 0,
      pythonExecutable: null,
      runtimeInstalled: false,
      runtimeManifestValid: false,
      statusReadable: false,
      availableProviders: [],
      selectedDevice: "cpu",
      activeBackend: null,
      workerRunning: false,
      runtimeError: null,
      error: "本地模型管理需要桌面版。"
    };
  }
  return invoke<LocalModelStatus>("check_local_model");
}

export async function downloadLocalModel(): Promise<void> {
  if (!isDesktop()) throw new Error("本地模型下载需要桌面版。");
  await invoke("download_local_model");
}

export async function installLocalRuntime(device: string): Promise<void> {
  if (!isDesktop()) throw new Error("本地运行环境需要桌面版。");
  await invoke("install_local_runtime", { device });
}

export async function setupLocalModel(taskId: string): Promise<string> {
  if (!isDesktop()) throw new Error("本地模型一键配置需要桌面版。");
  return invoke<string>("setup_local_model", { taskId });
}

export async function rebuildLocalEnvironment(taskId: string): Promise<string> {
  if (!isDesktop()) throw new Error("本地环境重建需要桌面版。");
  return invoke<string>("rebuild_local_environment", { taskId });
}

export async function deleteLocalModel(): Promise<void> {
  if (isDesktop()) await invoke("delete_local_model");
}

export async function recognizeLocal(taskId: string, imageDataUrl: string, device: string): Promise<LocalRecognitionResult> {
  if (!isDesktop()) throw new Error("本地识别需要桌面版。");
  return invoke<LocalRecognitionResult>("recognize_local", { taskId, imageDataUrl, device });
}

export async function listenForFileDrop(handler: (paths: string[]) => void): Promise<() => void> {
  if (!isDesktop()) return () => undefined;
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") handler(event.payload.paths);
  });
}

export async function copyText(text: string): Promise<void> {
  if (isDesktop()) {
    await writeClipboardText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

function imageCopyDiagnostic(reason: unknown): string {
  let value = reason instanceof Error ? reason.message : String(reason);
  value = value.replace(/sk-[^\s"' ,;]+/g, "sk-[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  return value.slice(0, 1200);
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Canvas 未生成 PNG 数据")), "image/png");
  });
}

export async function copyFormulaImage(node: HTMLElement): Promise<void> {
  let stage = "字体准备";
  let canvas: HTMLCanvasElement | null = null;
  let image: Awaited<ReturnType<typeof TauriImage.new>> | null = null;
  try {
    await document.fonts.ready;
    const families = ["KaTeX_Main", "KaTeX_Math", "KaTeX_Size1", "KaTeX_AMS"];
    await Promise.all(families.map((family) => document.fonts.load('16px "' + family + '"')));
    if (!document.fonts.check('16px "KaTeX_Main"')) {
      throw new Error("KaTeX 数学字体尚未加载");
    }

    stage = "字体嵌入";
    const { toCanvas, getFontEmbedCSS } = await import("html-to-image");
    const fontEmbedCSS = await getFontEmbedCSS(node);
    if (!fontEmbedCSS.includes("base64,") || !fontEmbedCSS.toLowerCase().includes("@font-face")) {
      throw new Error("公式字体未能嵌入 PNG");
    }

    stage = "公式栅格化";
    const captureWidth = Math.max(1, node.scrollWidth, Math.ceil(node.getBoundingClientRect().width));
    const captureHeight = Math.max(1, node.scrollHeight, Math.ceil(node.getBoundingClientRect().height));
    canvas = await toCanvas(node, {
      width: captureWidth,
      height: captureHeight,
      backgroundColor: "#ffffff",
      pixelRatio: 2,
      fontEmbedCSS,
      style: { maxWidth: "none", overflow: "visible" }
    });
    if (!canvas.width || !canvas.height) throw new Error("公式画布尺寸为零");

    stage = "PNG 数据转换";
    const blob = await canvasPng(canvas);
    if (!blob.size) throw new Error("PNG 数据为空");

    if (!isDesktop()) {
      stage = "写入剪贴板";
      if (!navigator.clipboard?.write) throw new Error("当前浏览器不支持图片剪贴板");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return;
    }

    stage = "读取像素";
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法读取公式像素");
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;

    stage = "写入剪贴板";
    image = await TauriImage.new(new Uint8Array(rgba), canvas.width, canvas.height);
    await writeClipboardImage(image);
  } catch (reason) {
    const descriptions: Record<string, string> = {
      "字体准备": "公式图片复制失败：数学字体尚未准备好。",
      "字体嵌入": "公式图片复制失败：无法读取并嵌入随应用提供的公式字体。",
      "公式栅格化": "公式图片复制失败：无法将预览渲染为图片。",
      "PNG 数据转换": "公式图片复制失败：PNG 数据生成失败。",
      "读取像素": "公式图片复制失败：无法读取 PNG 像素数据。",
      "写入剪贴板": "公式图片已生成，但写入系统剪贴板失败。"
    };
    const diagnostic = imageCopyDiagnostic(reason);
    console.error("[FormulaSnap] " + stage + ": " + diagnostic);
    if (isDesktop()) await invoke("record_diagnostic_log", { category: "formula-image-copy", message: stage + ": " + diagnostic }).catch(() => undefined);
    throw new Error((descriptions[stage] ?? "公式图片复制失败。") + "请重试；若持续发生，可查看应用诊断日志。");
  } finally {
    if (image) {
      try { await image.close(); } catch { /* Clipboard data is already copied. */ }
    }
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

export async function saveWordDocument(path: string, blob: Blob): Promise<number> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const documentBase64 = btoa(binary);
  return invoke<number>("save_word_document", { path, documentBase64 });
}
export function makeId(): string {
  return crypto.randomUUID();
}

