import { describe, expect, it, vi } from "vitest";
import { createRecognitionConfigSnapshot, dispatchRecognition, resolveBatchEnginePreference } from "./batch-engine";
import type { ApiService, AppPreferences } from "./types";

const defaultService: ApiService = {
  id: "deepseek-default",
  name: "DeepSeek",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-flash",
  adapter: "deepseek-vision",
  visionVerified: false,
  hasKey: false
};
const defaultPreferences: AppPreferences = {
  selectedServiceId: defaultService.id,
  mode: "local",
  output: "latex",
  autoTrim: true,
  localDevice: "cpu",
  codexCliPath: ""
};
const apiService: ApiService = {
  ...defaultService,
  id: "custom-api",
  name: "团队视觉 API",
  endpoint: "https://vision.example/v1/chat/completions",
  model: "vision-equation-v2",
  adapter: "openai-compatible-vision",
  hasKey: true
};

describe("batch recognition engine selection", () => {
  it("restores saved batch choices and migrates old preferences from the single-image choice", () => {
    expect(resolveBatchEnginePreference({ ...defaultPreferences, mode: "codex" }, "deepseek-default", ["deepseek-default"]))
      .toEqual({ mode: "codex", serviceId: "deepseek-default" });
    expect(resolveBatchEnginePreference({ ...defaultPreferences, mode: "local", batchMode: "online", batchServiceId: "custom-api" }, "deepseek-default", ["deepseek-default", "custom-api"]))
      .toEqual({ mode: "online", serviceId: "custom-api" });
  });

  it("falls back to a valid service when a previously selected batch service was removed", () => {
    expect(resolveBatchEnginePreference({ ...defaultPreferences, batchMode: "online", batchServiceId: "deleted" }, "deepseek-default", ["deepseek-default"]))
      .toEqual({ mode: "online", serviceId: "deepseek-default" });
  });

  it("keeps an immutable round snapshot when service details change", async () => {
    const mutableService = { ...apiService };
    const config = createRecognitionConfigSnapshot("online", mutableService, "cpu", " C:/Codex/codex.exe ");
    mutableService.model = "changed-after-start";
    const handlers = {
      online: vi.fn(async (service: ApiService) => service.model),
      local: vi.fn(async () => "local"),
      codex: vi.fn(async () => "codex")
    };
    await expect(dispatchRecognition(config, handlers)).resolves.toBe("vision-equation-v2");
    expect(config.codexCliPath).toBe("C:/Codex/codex.exe");
    expect(handlers.online).toHaveBeenCalledTimes(1);
    expect(handlers.local).not.toHaveBeenCalled();
    expect(handlers.codex).not.toHaveBeenCalled();
  });

  it.each([
    ["local", "local"],
    ["online", "online"],
    ["codex", "codex"]
  ] as const)("routes %s only to its selected provider", async (mode, expected) => {
    const config = createRecognitionConfigSnapshot(mode, apiService, "cuda", "codex.exe");
    const handlers = {
      online: vi.fn(async () => "online"),
      local: vi.fn(async () => "local"),
      codex: vi.fn(async () => "codex")
    };
    await expect(dispatchRecognition(config, handlers)).resolves.toBe(expected);
    expect(handlers[expected]).toHaveBeenCalledTimes(1);
    expect(Object.entries(handlers).filter(([key]) => key !== expected).every(([, handler]) => handler.mock.calls.length === 0)).toBe(true);
    if (mode === "online") expect(handlers.online).toHaveBeenCalledWith(config.service);
    if (mode === "local") expect(handlers.local).toHaveBeenCalledWith("cuda");
    if (mode === "codex") expect(handlers.codex).toHaveBeenCalledWith("codex.exe");
  });

  it("does not route an unknown runtime mode to local OCR", async () => {
    const config = { ...createRecognitionConfigSnapshot("online", apiService, "cpu", ""), mode: "unexpected" } as never;
    const local = vi.fn(async () => "local");
    await expect(dispatchRecognition(config, { online: vi.fn(async () => "online"), local, codex: vi.fn(async () => "codex") }))
      .rejects.toThrow("不支持的识别引擎");
    expect(local).not.toHaveBeenCalled();
  });
});
