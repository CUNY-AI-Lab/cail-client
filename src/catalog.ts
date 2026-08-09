import { bodyError, CailError } from "./errors.js";

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

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const TIERS = new Set<CailModelTier>(["recommended", "advanced"]);
const STATUSES = new Set<CailModelStatus>(["active", "deprecated", "retiring"]);
const MODALITIES = new Set<CailModelModality>(["text", "image"]);
const PROVIDERS = new Set<CailModelProvider>(["workers-ai", "openrouter"]);
const PRICING = new Set<CailPricingState>(["catalog", "verified-live"]);

function own(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !CONTROL_CHARACTERS.test(value);
}

function optionalText(value: unknown): value is string | undefined {
  return value === undefined || text(value);
}

function values(value: unknown): unknown[] | null {
  if (value === null || typeof value !== "object") return null;
  try {
    if (!Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value as object);
    const lengthDescriptor = descriptors["length"];
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) return null;
    const length = lengthDescriptor.value;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      result.push(descriptor.value);
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === "length") continue;
      if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
    }
    return result;
  } catch {
    return null;
  }
}

function parseEntry(value: unknown, status: number): CailModelCatalogEntry {
  if (!record(value)) throw bodyError(status, "catalog");
  const id = own(value, "id");
  const tier = own(value, "tier");
  const modelStatus = own(value, "status");
  const modality = own(value, "modality");
  const provider = own(value, "provider");
  const pricing = own(value, "pricing_known");
  const capabilities = values(own(value, "capabilities"));
  const contextLength = own(value, "context_length");
  const registryUrl = own(value, "registry_url");
  const sunset = own(value, "sunset");
  const order = own(value, "order");
  const recommended = own(value, "recommended");
  const upstream = own(value, "upstream_model");
  const streaming = own(value, "streaming");
  const capabilitySet = new Set<string>();
  const parsedCapabilities = capabilities?.map((item) => {
    if (!text(item) || capabilitySet.has(item)) throw bodyError(status, "catalog");
    capabilitySet.add(item);
    return item;
  });
  if (
    !text(id) ||
    own(value, "object") !== "model" ||
    typeof recommended !== "boolean" ||
    typeof tier !== "string" || !TIERS.has(tier as CailModelTier) ||
    recommended !== (tier === "recommended") ||
    typeof order !== "number" || !Number.isSafeInteger(order) || order < 0 ||
    typeof modelStatus !== "string" || !STATUSES.has(modelStatus as CailModelStatus) ||
    typeof modality !== "string" || !MODALITIES.has(modality as CailModelModality) ||
    typeof provider !== "string" || !PROVIDERS.has(provider as CailModelProvider) ||
    !text(upstream) ||
    typeof pricing !== "string" || !PRICING.has(pricing as CailPricingState) ||
    typeof streaming !== "boolean" ||
    (sunset !== null && (typeof sunset !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(sunset))) ||
    parsedCapabilities === undefined ||
    (contextLength !== null && (typeof contextLength !== "number" || !Number.isSafeInteger(contextLength) || contextLength < 1)) ||
    (registryUrl !== null && (typeof registryUrl !== "string" || !registryUrl.startsWith("https://") || CONTROL_CHARACTERS.test(registryUrl))) ||
    !optionalText(own(value, "name")) ||
    !optionalText(own(value, "description")) ||
    !optionalText(own(value, "task"))
  ) {
    throw bodyError(status, "catalog");
  }
  const result: CailModelCatalogEntry = {
    id,
    object: "model",
    recommended,
    tier: tier as CailModelTier,
    order,
    status: modelStatus as CailModelStatus,
    modality: modality as CailModelModality,
    provider: provider as CailModelProvider,
    upstream_model: upstream,
    pricing_known: pricing as CailPricingState,
    streaming,
    sunset,
    capabilities: parsedCapabilities,
    context_length: contextLength,
    registry_url: registryUrl,
  };
  const name = own(value, "name");
  const description = own(value, "description");
  const task = own(value, "task");
  if (typeof name === "string") result.name = name;
  if (typeof description === "string") result.description = description;
  if (typeof task === "string") result.task = task;
  return result;
}

export function parseCailModelCatalog(value: unknown, status = 200): CailModelCatalog {
  try {
    if (!record(value) || own(value, "object") !== "list") throw bodyError(status, "catalog");
    const data = values(own(value, "data"));
    if (data === null) throw bodyError(status, "catalog");
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
