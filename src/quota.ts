import { boundedBodyError } from "./errors.js";

export type CailQuotaWindowTechnique = "fixed" | "sliding";
export type CailQuotaState = "estimated";

export interface CailQuota {
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

export interface CailQuotaSnapshot extends CailQuota {}

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

function own(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyExpectedKeys(value: object): boolean {
  try {
    return Object.getOwnPropertyNames(value).every((key) => KEYS.has(key));
  } catch {
    return false;
  }
}

export function parseCailQuotaSnapshot(value: unknown, status = 200): CailQuotaSnapshot {
  let array = false;
  try {
    array = Array.isArray(value);
  } catch {
    array = true;
  }
  if (value === null || typeof value !== "object" || array || !hasOnlyExpectedKeys(value)) {
    throw boundedBodyError(status, "quota");
  }

  const object = own(value, "object");
  const managedBy = own(value, "managed_by");
  const state = own(value, "state");
  const unit = own(value, "unit");
  const currency = own(value, "currency");
  const limit = own(value, "limit");
  const estimatedUsed = own(value, "estimated_used");
  const estimatedRemaining = own(value, "estimated_remaining");
  const usedPercent = own(value, "used_percent");
  const remainingPercent = own(value, "remaining_percent");
  const windowSeconds = own(value, "window_seconds");
  const windowTechnique = own(value, "window_technique");
  const calculatedAt = own(value, "calculated_at");

  if (
    object !== "quota" ||
    managedBy !== "cloudflare" ||
    state !== "estimated" ||
    unit !== "microdollar" ||
    currency !== "USD" ||
    !integer(limit) ||
    limit === 0 ||
    !integer(estimatedUsed) ||
    !integer(estimatedRemaining) ||
    !integer(usedPercent) ||
    usedPercent > 100 ||
    !integer(remainingPercent) ||
    remainingPercent > 100 ||
    !integer(windowSeconds) ||
    windowSeconds === 0 ||
    (windowTechnique !== "fixed" && windowTechnique !== "sliding") ||
    !integer(calculatedAt) ||
    estimatedRemaining !== Math.max(0, limit - estimatedUsed) ||
    usedPercent !== Math.min(100, Math.max(0, Math.round((estimatedUsed / limit) * 100))) ||
    remainingPercent !== 100 - usedPercent
  ) {
    throw boundedBodyError(status, "quota");
  }

  return {
    object,
    managed_by: managedBy,
    state,
    unit,
    currency,
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
