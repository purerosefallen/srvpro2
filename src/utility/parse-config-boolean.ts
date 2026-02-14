export function parseConfigBoolean(
  value: unknown,
  defaultValue = false,
): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (defaultValue) {
      return !(
        normalized === '0' ||
        normalized === 'false' ||
        normalized === 'null'
      );
    }
    return !(
      normalized === '' ||
      normalized === '0' ||
      normalized === 'false' ||
      normalized === 'null'
    );
  }

  if (value == null) {
    return defaultValue;
  }

  return Boolean(value);
}
