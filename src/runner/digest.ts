import { createHash } from "node:crypto";

// Canonical JSON: object keys sorted recursively, no whitespace.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    // Only reachable inside arrays (object properties are filtered below);
    // JSON.stringify writes null there.
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${parts.join(",")}}`;
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
