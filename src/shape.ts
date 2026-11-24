export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function keySetError(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  const actual = Object.keys(value);
  const missing = keys.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !keys.includes(k));
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing keys: ${missing.join(", ")}`);
  if (extra.length > 0) parts.push(`unexpected keys: ${extra.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}
