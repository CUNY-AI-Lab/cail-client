import { bodyError, CailError } from "./errors.js";
import {
  arrayItemsFrom,
  booleanFrom,
  hasControlCharacters,
  numberFrom,
  plainRecordFrom,
  stringFrom,
} from "./validation.js";
import type { RecordSnapshot, RuntimeProperty } from "./validation.js";

export type CailModelTier = "recommended" | "advanced";
export type CailModelStatus = "active" | "deprecated" | "retiring";
export type CailModelModality = "text" | "image";
export type CailModelProvider = "workers-ai" | "openrouter";
export type CailPricingState = "catalog" | "verified-live";

export interface CailModelCatalogEntry {
  id: string;
  object: "model";
  recommended: boolean;
  tier: CailModelTier;
  order: number;
  status: CailModelStatus;
  modality: CailModelModality;
  provider: CailModelProvider;
  upstream_model: string;
  pricing_known: CailPricingState;
  streaming: boolean;
  sunset: string | null;
  capabilities: string[];
  context_length: number | null;
  registry_url: string | null;
  name?: string;
  description?: string;
  task?: string;
}

export interface CailModelCatalog {
  object: "list";
  data: CailModelCatalogEntry[];
}

export type CailCatalogModality = "text" | "image" | "all";

export type CailQuotaWindowTechnique = "fixed" | "sliding";
export type CailQuotaState = "estimated";

export interface CailQuotaSnapshot {
  object: "quota";
  managed_by: "cloudflare";
  state: CailQuotaState;
  unit: "microdollar";
  currency: "USD";
  limit: number;
  estimated_used: number;
  estimated_remaining: number;
  used_percent: number;
  remaining_percent: number;
  window_seconds: number;
  window_technique: CailQuotaWindowTechnique;
  calculated_at: number;
}

function text<Value>(value: Value): string | undefined {
  const item = stringFrom(value);
  return item !== undefined && item.length > 0 && !hasControlCharacters(item)
    ? item
    : undefined;
}

function tierFrom<Value>(value: Value): CailModelTier | undefined {
  const item = stringFrom(value);
  return item === "recommended" || item === "advanced" ? item : undefined;
}

function statusFrom<Value>(value: Value): CailModelStatus | undefined {
  const item = stringFrom(value);
  return item === "active" || item === "deprecated" || item === "retiring"
    ? item
    : undefined;
}

function modalityFrom<Value>(value: Value): CailModelModality | undefined {
  const item = stringFrom(value);
  return item === "text" || item === "image" ? item : undefined;
}

function providerFrom<Value>(value: Value): CailModelProvider | undefined {
  const item = stringFrom(value);
  return item === "workers-ai" || item === "openrouter" ? item : undefined;
}

function pricingFrom<Value>(value: Value): CailPricingState | undefined {
  const item = stringFrom(value);
  return item === "catalog" || item === "verified-live" ? item : undefined;
}

type OptionalTextResult = { valid: boolean; text?: string };

function optionalTextValid(value: RuntimeProperty): OptionalTextResult {
  if (value === undefined) return { valid: true };
  const item = text(value);
  return item === undefined ? { valid: false } : { valid: true, text: item };
}

function parseEntry<Value>(value: Value, status: number): CailModelCatalogEntry {
  const fields = plainRecordFrom(value);
  if (fields === undefined) throw bodyError(status, "catalog");

  const id = text(fields.read("id"));
  const tier = tierFrom(fields.read("tier"));
  const modelStatus = statusFrom(fields.read("status"));
  const modality = modalityFrom(fields.read("modality"));
  const provider = providerFrom(fields.read("provider"));
  const pricing = pricingFrom(fields.read("pricing_known"));
  const capabilities = arrayItemsFrom(fields.read("capabilities"));
  const contextLengthRaw = fields.read("context_length");
  const contextLength = numberFrom(contextLengthRaw);
  const parsedContextLength = contextLengthRaw === null ? null : contextLength;
  const registryUrlRaw = fields.read("registry_url");
  const registryUrl = stringFrom(registryUrlRaw);
  const parsedRegistryUrl = registryUrlRaw === null ? null : registryUrl;
  const sunsetRaw = fields.read("sunset");
  const sunset = stringFrom(sunsetRaw);
  const parsedSunset = sunsetRaw === null ? null : sunset;
  const order = numberFrom(fields.read("order"));
  const recommended = booleanFrom(fields.read("recommended"));
  const upstream = text(fields.read("upstream_model"));
  const streaming = booleanFrom(fields.read("streaming"));
  const capabilitySet = new Set<string>();
  const parsedCapabilities = capabilities?.map((item) => {
    const capability = text(item);
    if (capability === undefined || capabilitySet.has(capability)) {
      throw bodyError(status, "catalog");
    }
    capabilitySet.add(capability);
    return capability;
  });
  const name = optionalTextValid(fields.read("name"));
  const description = optionalTextValid(fields.read("description"));
  const task = optionalTextValid(fields.read("task"));

  if (
    id === undefined ||
    fields.read("object") !== "model" ||
    recommended === undefined ||
    tier === undefined ||
    recommended !== (tier === "recommended") ||
    order === undefined ||
    !Number.isSafeInteger(order) ||
    order < 0 ||
    modelStatus === undefined ||
    modality === undefined ||
    provider === undefined ||
    upstream === undefined ||
    pricing === undefined ||
    streaming === undefined ||
    parsedSunset === undefined ||
    (parsedSunset !== null && !/^\d{4}-\d{2}-\d{2}$/.test(parsedSunset)) ||
    parsedCapabilities === undefined ||
    parsedContextLength === undefined ||
    (parsedContextLength !== null &&
      (!Number.isSafeInteger(parsedContextLength) || parsedContextLength < 1)) ||
    parsedRegistryUrl === undefined ||
    (parsedRegistryUrl !== null &&
      (!parsedRegistryUrl.startsWith("https://") ||
        hasControlCharacters(parsedRegistryUrl))) ||
    !name.valid ||
    !description.valid ||
    !task.valid
  ) {
    throw bodyError(status, "catalog");
  }

  const result: CailModelCatalogEntry = {
    id,
    object: "model",
    recommended,
    tier,
    order,
    status: modelStatus,
    modality,
    provider,
    upstream_model: upstream,
    pricing_known: pricing,
    streaming,
    sunset: parsedSunset,
    capabilities: parsedCapabilities,
    context_length: parsedContextLength,
    registry_url: parsedRegistryUrl,
  };
  if (name.text !== undefined) result.name = name.text;
  if (description.text !== undefined) result.description = description.text;
  if (task.text !== undefined) result.task = task.text;
  return result;
}

export function parseCailModelCatalog<Value>(value: Value, status = 200): CailModelCatalog {
  try {
    const fields = plainRecordFrom(value);
    if (fields === undefined || fields.read("object") !== "list") {
      throw bodyError(status, "catalog");
    }
    const data = arrayItemsFrom(fields.read("data"));
    if (data === undefined) throw bodyError(status, "catalog");
    const ids = new Set<string>();
    const parsed = data.map((entry) => {
      const item = parseEntry(entry, status);
      if (ids.has(item.id)) throw bodyError(status, "catalog");
      ids.add(item.id);
      return item;
    });
    return { object: "list", data: parsed };
  } catch (error) {
    if (error instanceof CailError) throw error;
    throw bodyError(status, "catalog");
  }
}

const KEYS = new Set([
  "object",
  "managed_by",
  "state",
  "unit",
  "currency",
  "limit",
  "estimated_used",
  "estimated_remaining",
  "used_percent",
  "remaining_percent",
  "window_seconds",
  "window_technique",
  "calculated_at",
]);

function integer<Value>(value: Value): number | undefined {
  const item = numberFrom(value);
  return item !== undefined && Number.isSafeInteger(item) && item >= 0
    ? item
    : undefined;
}

function hasOnlyExpectedKeys(fields: RecordSnapshot): boolean {
  try {
    return fields.names().every((key) => KEYS.has(key));
  } catch {
    return false;
  }
}

export function parseCailQuotaSnapshot<Value>(value: Value, status = 200): CailQuotaSnapshot {
  const fields = plainRecordFrom(value);
  if (fields === undefined || !hasOnlyExpectedKeys(fields)) {
    throw bodyError(status, "quota");
  }

  const objectValue = fields.read("object");
  const managedBy = fields.read("managed_by");
  const state = fields.read("state");
  const unit = fields.read("unit");
  const currency = fields.read("currency");
  const limit = integer(fields.read("limit"));
  const estimatedUsed = integer(fields.read("estimated_used"));
  const estimatedRemaining = integer(fields.read("estimated_remaining"));
  const usedPercent = integer(fields.read("used_percent"));
  const remainingPercent = integer(fields.read("remaining_percent"));
  const windowSeconds = integer(fields.read("window_seconds"));
  const windowTechnique = stringFrom(fields.read("window_technique"));
  const calculatedAt = integer(fields.read("calculated_at"));

  if (
    objectValue !== "quota" ||
    managedBy !== "cloudflare" ||
    state !== "estimated" ||
    unit !== "microdollar" ||
    currency !== "USD" ||
    limit === undefined ||
    limit === 0 ||
    estimatedUsed === undefined ||
    estimatedRemaining === undefined ||
    usedPercent === undefined ||
    usedPercent > 100 ||
    remainingPercent === undefined ||
    remainingPercent > 100 ||
    windowSeconds === undefined ||
    windowSeconds === 0 ||
    (windowTechnique !== "fixed" && windowTechnique !== "sliding") ||
    calculatedAt === undefined ||
    estimatedRemaining !== Math.max(0, limit - estimatedUsed) ||
    usedPercent !== Math.min(100, Math.max(0, Math.round((estimatedUsed / limit) * 100))) ||
    remainingPercent !== 100 - usedPercent
  ) {
    throw bodyError(status, "quota");
  }

  return {
    object: "quota",
    managed_by: "cloudflare",
    state: "estimated",
    unit: "microdollar",
    currency: "USD",
    limit,
    estimated_used: estimatedUsed,
    estimated_remaining: estimatedRemaining,
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    window_seconds: windowSeconds,
    window_technique: windowTechnique,
    calculated_at: calculatedAt,
  };
}
