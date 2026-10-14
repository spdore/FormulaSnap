import type { ApiService } from "./types";

export function imageApiBlockReason(service: ApiService): string | null {
  return service.hasKey ? null : "这个 API 服务还没有密钥。请在“设置 → API 服务”保存密钥。";
}

export function isBuiltInDeepSeekVisionPreset(service: ApiService): boolean {
  const endpoint = service.endpoint.trim();
  const normalizedEndpoint = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return service.adapter === "deepseek-vision"
    && normalizedEndpoint === "https://api.deepseek.com/chat/completions"
    && service.model.trim() === "deepseek-flash";
}