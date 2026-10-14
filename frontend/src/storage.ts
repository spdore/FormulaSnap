import { openDB, type DBSchema } from "idb";
import type { ApiService, AppPreferences, FormulaRecord } from "./types";

interface FormulaSnapDatabase extends DBSchema {
  services: {
    key: string;
    value: ApiService;
  };
  history: {
    key: string;
    value: FormulaRecord;
    indexes: { "by-created-at": number };
  };
  preferences: {
    key: string;
    value: AppPreferences;
  };
}

const dbPromise = openDB<FormulaSnapDatabase>("formulasnap", 2, {
  upgrade(db) {
    if (!db.objectStoreNames.contains("services")) {
      db.createObjectStore("services", { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains("history")) {
      const history = db.createObjectStore("history", { keyPath: "id" });
      history.createIndex("by-created-at", "createdAt");
    }
    if (!db.objectStoreNames.contains("preferences")) {
      db.createObjectStore("preferences");
    }
  }
});

export const defaultService: ApiService = {
  id: "deepseek-default",
  name: "DeepSeek",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-flash",
  adapter: "deepseek-vision",
  visionVerified: false,
  hasKey: false
};

export const defaultPreferences: AppPreferences = {
  selectedServiceId: defaultService.id,
  mode: "local",
  output: "latex",
  autoTrim: true,
  localDevice: "cpu",
  codexCliPath: ""
};

export async function loadAppPreferences(): Promise<AppPreferences> {
  const db = await dbPromise;
  return { ...defaultPreferences, ...(await db.get("preferences", "app")) };
}

export async function saveAppPreferences(preferences: AppPreferences): Promise<void> {
  const db = await dbPromise;
  await db.put("preferences", preferences, "app");
}

export async function listServices(): Promise<ApiService[]> {
  const db = await dbPromise;
  const saved = await db.getAll("services");
  if (saved.length) return saved.map((service) => ({ ...service, visionVerified: Boolean(service.visionVerified), hasKey: Boolean(service.hasKey) }));
  await db.put("services", defaultService);
  return [defaultService];
}

export async function saveService(service: ApiService): Promise<void> {
  const db = await dbPromise;
  await db.put("services", service);
}

export async function deleteService(id: string): Promise<void> {
  if (id === defaultService.id) return;
  const db = await dbPromise;
  await db.delete("services", id);
}

export async function saveRecord(record: FormulaRecord): Promise<void> {
  const db = await dbPromise;
  await db.put("history", record);
}

export async function getRecord(id: string): Promise<FormulaRecord | undefined> {
  const db = await dbPromise;
  return db.get("history", id);
}

export async function listRecords(): Promise<FormulaRecord[]> {
  const db = await dbPromise;
  return (await db.getAll("history")).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteRecord(id: string): Promise<void> {
  const db = await dbPromise;
  await db.delete("history", id);
}

export async function clearHistory(): Promise<void> {
  const db = await dbPromise;
  await db.clear("history");
}

export async function updateRecordLatexIfExists(id: string, latex: string): Promise<FormulaRecord | null> {
  const db = await dbPromise;
  const tx = db.transaction("history", "readwrite");
  const existing = await tx.store.get(id);
  if (!existing) {
    await tx.done;
    return null;
  }
  const updated = { ...existing, latex };
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

export async function updateServiceRequestStatus(
  id: string, at: number, ok: boolean, error?: string
): Promise<ApiService | null> {
  const db = await dbPromise;
  const tx = db.transaction("services", "readwrite");
  const existing = await tx.store.get(id);
  if (!existing) {
    await tx.done;
    return null;
  }
  const updated: ApiService = {
    ...existing,
    lastImageRequestAt: at,
    lastImageRequestOk: ok,
    lastImageRequestError: ok ? undefined : (error || "图片识别请求失败。").slice(0, 240)
  };
  await tx.store.put(updated);
  await tx.done;
  return updated;
}