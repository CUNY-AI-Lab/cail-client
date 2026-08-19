import * as z from "zod/mini";

const BOOLEAN_SCHEMA = z.boolean();
const CALLABLE_SCHEMA = z.function();
const NUMBER_SCHEMA = z.number();
const STRING_SCHEMA = z.string();

export type RuntimeProperty =
  | bigint
  | boolean
  | null
  | number
  | object
  | string
  | symbol
  | undefined;

export type PropertySnapshot = Readonly<{
  present: boolean;
  readable: boolean;
  enumerable: boolean;
  value?: RuntimeProperty;
}>;

export type RecordSnapshot = Readonly<{
  has(key: string): boolean;
  names(): string[];
  property(key: string): PropertySnapshot;
  read(key: string): RuntimeProperty;
}>;

export function booleanFrom<Value>(value: Value): boolean | undefined {
  const result = BOOLEAN_SCHEMA.safeParse(value);
  return result.success ? result.data : undefined;
}

export function callableFrom<Value>(value: Value) {
  const result = CALLABLE_SCHEMA.safeParse(value);
  return result.success ? result.data : undefined;
}

export function numberFrom<Value>(value: Value): number | undefined {
  const result = NUMBER_SCHEMA.safeParse(value);
  return result.success ? result.data : undefined;
}

export function stringFrom<Value>(value: Value): string | undefined {
  const result = STRING_SCHEMA.safeParse(value);
  return result.success ? result.data : undefined;
}

export function plainRecordFrom<Value>(value: Value): RecordSnapshot | undefined {
  try {
    if (value === null || Object(value) !== value || callableFrom(value) !== undefined || Array.isArray(value)) {
      return undefined;
    }
    // SAFETY: Object identity established that the original value is an object;
    // callable and array values were rejected immediately above.
    const owner = value as object;
    const property = (key: string): PropertySnapshot => {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor === undefined) return { present: false, readable: false, enumerable: false };
      const enumerable = descriptor.enumerable === true;
      if (!("value" in descriptor)) return { present: true, readable: false, enumerable };
      return { present: true, readable: true, enumerable, value: descriptor.value };
    };
    return Object.freeze({
      has(key: string): boolean {
        return property(key).present;
      },
      names(): string[] {
        return Object.getOwnPropertyNames(owner);
      },
      property,
      read(key: string): RuntimeProperty {
        const item = property(key);
        return item.readable ? item.value : undefined;
      },
    });
  } catch {
    return undefined;
  }
}

export function propertyFrom<Value>(value: Value | undefined, key: string): PropertySnapshot {
  if (value === undefined) return { present: false, readable: false, enumerable: false };
  try {
    return plainRecordFrom(value)?.property(key) ?? { present: true, readable: false, enumerable: false };
  } catch {
    return { present: true, readable: false, enumerable: false };
  }
}

export function referenceFrom<Value>(value: Value): object | undefined {
  try {
    if (value === null || Object(value) !== value) return undefined;
    return Object(value);
  } catch {
    return undefined;
  }
}

export function arrayItemsFrom<Value>(value: Value): RuntimeProperty[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const descriptorEntries = Object.entries(descriptors);
    const lengthDescriptor = descriptorEntries.find(([key]) => key === "length")?.[1];
    const length = lengthDescriptor?.value;
    const safeLength = numberFrom(length);
    if (safeLength === undefined || !Number.isSafeInteger(safeLength) || safeLength < 0) {
      return undefined;
    }
    const result: RuntimeProperty[] = [];
    for (let index = 0; index < safeLength; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      result.push(descriptor.value);
    }
    for (const [key, descriptor] of descriptorEntries) {
      if (key === "length") continue;
      if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= safeLength || !descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }
    }
    return result;
  } catch {
    return undefined;
  }
}

export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}
