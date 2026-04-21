export function isObjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function cloneJson<T>(value: T): T {
  if (value == null) {
    return value;
  }
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function fillMissingJsonFields<T>(value: unknown, defaults: T) {
  if (Array.isArray(defaults)) {
    if (!Array.isArray(value)) {
      return {
        value: cloneJson(defaults),
        changed: true,
      };
    }
    return {
      value: cloneJson(value) as T,
      changed: false,
    };
  }

  if (isObjectRecord(defaults)) {
    if (!isObjectRecord(value)) {
      return {
        value: cloneJson(defaults),
        changed: true,
      };
    }

    let changed = false;
    const nextValue: Record<string, unknown> = {
      ...value,
    };

    for (const [key, defaultValue] of Object.entries(defaults)) {
      const merged = fillMissingJsonFields(
        (value as Record<string, unknown>)[key],
        defaultValue,
      );
      nextValue[key] = merged.value;
      changed = changed || merged.changed || !(key in value);
    }

    return {
      value: nextValue as T,
      changed,
    };
  }

  if (value === undefined) {
    return {
      value: cloneJson(defaults),
      changed: true,
    };
  }

  return {
    value: value as T,
    changed: false,
  };
}
