import { boundedBodyError, CailError } from "./errors.js";
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const TIERS = new Set(["recommended", "advanced"]);
const STATUSES = new Set(["active", "deprecated", "retiring"]);
const MODALITIES = new Set(["text", "image"]);
const PROVIDERS = new Set(["workers-ai", "openrouter"]);
const PRICING = new Set(["catalog", "verified-live"]);
function own(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    }
    catch {
        return undefined;
    }
}
function record(value) {
    if (value === null || typeof value !== "object")
        return false;
    try {
        return !Array.isArray(value);
    }
    catch {
        return false;
    }
}
function safeString(value, max) {
    return typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL_CHARACTERS.test(value);
}
function optionalString(value, max) {
    return value === undefined || safeString(value, max);
}
function safeArrayValues(value, maxLength) {
    if (value === null || typeof value !== "object")
        return null;
    try {
        if (!Array.isArray(value))
            return null;
    }
    catch {
        return null;
    }
    let descriptors;
    try {
        descriptors = Object.getOwnPropertyDescriptors(value);
    }
    catch {
        return null;
    }
    const lengthDescriptor = descriptors.length;
    if (lengthDescriptor === undefined ||
        lengthDescriptor.enumerable ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > maxLength) {
        return null;
    }
    const length = lengthDescriptor.value;
    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length")
            continue;
        if (key === "toJSON")
            return null;
        if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length)
            return null;
        if (!descriptor.enumerable || !("value" in descriptor))
            return null;
    }
    const values = [];
    for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
            return null;
        values.push(descriptor.value);
    }
    return values;
}
function entry(value, status) {
    if (!record(value))
        throw boundedBodyError(status, "catalog");
    const id = own(value, "id");
    const tier = own(value, "tier");
    const modelStatus = own(value, "status");
    const modality = own(value, "modality");
    const provider = own(value, "provider");
    const pricing = own(value, "pricing_known");
    const capabilities = own(value, "capabilities");
    const contextLength = own(value, "context_length");
    const registryUrl = own(value, "registry_url");
    const sunset = own(value, "sunset");
    const order = own(value, "order");
    const recommended = own(value, "recommended");
    const upstream = own(value, "upstream_model");
    const streaming = own(value, "streaming");
    const capabilityValues = safeArrayValues(capabilities, 32);
    const parsedCapabilities = [];
    const capabilitySet = new Set();
    let validCapabilities = capabilityValues !== null;
    if (capabilityValues !== null) {
        for (const capability of capabilityValues) {
            if (!safeString(capability, 64) || capabilitySet.has(capability)) {
                validCapabilities = false;
                break;
            }
            capabilitySet.add(capability);
            parsedCapabilities.push(capability);
        }
    }
    const validContext = contextLength === null ||
        (typeof contextLength === "number" && Number.isSafeInteger(contextLength) && contextLength >= 1);
    const validRegistry = registryUrl === null ||
        (typeof registryUrl === "string" && registryUrl.startsWith("https://") && registryUrl.length <= 2_048 && !CONTROL_CHARACTERS.test(registryUrl));
    if (!safeString(id, 128) ||
        own(value, "object") !== "model" ||
        typeof recommended !== "boolean" ||
        typeof tier !== "string" || !TIERS.has(tier) ||
        recommended !== (tier === "recommended") ||
        typeof order !== "number" || !Number.isSafeInteger(order) || order < 0 ||
        typeof modelStatus !== "string" || !STATUSES.has(modelStatus) ||
        typeof modality !== "string" || !MODALITIES.has(modality) ||
        typeof provider !== "string" || !PROVIDERS.has(provider) ||
        !safeString(upstream, 128) ||
        typeof pricing !== "string" || !PRICING.has(pricing) ||
        typeof streaming !== "boolean" ||
        (sunset !== null && (typeof sunset !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(sunset))) ||
        !validCapabilities ||
        !validContext ||
        !validRegistry ||
        !optionalString(own(value, "name"), 256) ||
        !optionalString(own(value, "description"), 2_048) ||
        !optionalString(own(value, "task"), 256)) {
        throw boundedBodyError(status, "catalog");
    }
    const result = {
        id,
        object: "model",
        recommended,
        tier: tier,
        order,
        status: modelStatus,
        modality: modality,
        provider: provider,
        upstream_model: upstream,
        pricing_known: pricing,
        streaming,
        sunset,
        capabilities: parsedCapabilities,
        context_length: contextLength,
        registry_url: registryUrl,
    };
    const name = own(value, "name");
    const description = own(value, "description");
    const task = own(value, "task");
    if (typeof name === "string")
        result.name = name;
    if (typeof description === "string")
        result.description = description;
    if (typeof task === "string")
        result.task = task;
    return result;
}
export function parseCailModelCatalog(value, status = 200) {
    try {
        if (!record(value) || own(value, "object") !== "list") {
            throw boundedBodyError(status, "catalog");
        }
        const data = own(value, "data");
        const dataValues = safeArrayValues(data, 2_000);
        if (dataValues === null) {
            throw boundedBodyError(status, "catalog");
        }
        const parsed = [];
        const ids = new Set();
        for (const item of dataValues) {
            const parsedItem = entry(item, status);
            if (ids.has(parsedItem.id))
                throw boundedBodyError(status, "catalog");
            ids.add(parsedItem.id);
            parsed.push(parsedItem);
        }
        return { object: "list", data: parsed };
    }
    catch (error) {
        if (error instanceof CailError)
            throw error;
        throw boundedBodyError(status, "catalog", error);
    }
}
