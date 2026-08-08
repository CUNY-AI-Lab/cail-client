import { boundedBodyError } from "./errors.js";
const SUBJECT = /^(?:cail|app)-[0-9a-f]{32}$/;
function own(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    }
    catch {
        return undefined;
    }
}
function integer(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function parseCailQuotaSnapshot(value, status = 200) {
    let array = false;
    try {
        array = Array.isArray(value);
    }
    catch {
        array = true;
    }
    if (value === null || typeof value !== "object" || array) {
        throw boundedBodyError(status, "quota");
    }
    const object = own(value, "object");
    const subject = own(value, "subject");
    const unit = own(value, "unit");
    const currency = own(value, "currency");
    const enforced = own(value, "enforced");
    const limit = own(value, "limit");
    const used = own(value, "used");
    const remaining = own(value, "remaining");
    const reset = own(value, "reset");
    const windowTechnique = own(value, "window_technique");
    const windowSeconds = own(value, "window_seconds");
    const state = own(value, "state");
    const asOf = own(value, "as_of");
    if (object !== "quota" ||
        typeof subject !== "string" || !SUBJECT.test(subject) ||
        unit !== "microdollar" || currency !== "USD" || typeof enforced !== "boolean" ||
        !integer(limit) || !integer(used) || !integer(remaining) ||
        (reset !== null && !integer(reset)) ||
        (windowTechnique !== "fixed" && windowTechnique !== "sliding") ||
        !integer(windowSeconds) || windowSeconds === 0 ||
        (state !== "ok" && state !== "stale") ||
        !integer(asOf) || limit === 0 || remaining !== Math.max(0, limit - used)) {
        throw boundedBodyError(status, "quota");
    }
    return {
        subject,
        limit,
        used,
        remaining,
        reset,
        window_technique: windowTechnique,
        window_seconds: windowSeconds,
        state,
        enforced,
        as_of: asOf,
    };
}
