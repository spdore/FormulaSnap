import { describe, expect, it } from "vitest";
import { imageApiBlockReason, isBuiltInDeepSeekVisionPreset } from "./recognition-service";
import type { ApiService } from "./types";

const oldDefaultDeepSeek: ApiService = {
  id: "deepseek-default",
  name: "DeepSeek",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-flash",
  adapter: "deepseek-vision",
  visionVerified: false,
  hasKey: true
};

describe("DeepSeek built-in image preset", () => {
  it("recognizes the verified endpoint/model preset without requiring legacy visionVerified", () => {
    expect(oldDefaultDeepSeek.visionVerified).toBe(false);
    expect(isBuiltInDeepSeekVisionPreset(oldDefaultDeepSeek)).toBe(true);
    expect(imageApiBlockReason(oldDefaultDeepSeek)).toBeNull();
  });

  it("requires a key but does not gate custom image services on prior validation", () => {
    const service: ApiService = {
      ...oldDefaultDeepSeek,
      endpoint: "https://vision.example/v1",
      model: "custom-vision",
      adapter: "openai-compatible-vision",
      visionVerified: false
    };
    expect(isBuiltInDeepSeekVisionPreset(service)).toBe(false);
    expect(imageApiBlockReason(service)).toBeNull();
    expect(imageApiBlockReason({ ...service, hasKey: false })).toContain("密钥");
  });
});