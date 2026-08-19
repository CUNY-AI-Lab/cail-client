import { bodyError } from "./errors.js";
import { numberFrom, plainRecordFrom, stringFrom } from "./validation.js";
import type { RecordSnapshot } from "./validation.js";

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
