import { dayNumber, isValidDateString } from "./dates.ts";
import type { Candidate, CostInput, PaymentRule, RunInput, Scenario } from "./types.ts";

export class RunInputError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "RunInputError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new RunInputError(path, message);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(path ? `${path}.${key}` : key, "unknown field");
  }
}

function reqString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  const field = path ? `${path}.${key}` : key;
  if (typeof value !== "string" || value.length === 0) {
    fail(field, "expected a non-empty string");
  }
  return value;
}

function optString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = obj[key];
  const field = path ? `${path}.${key}` : key;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    fail(field, "expected a non-empty string");
  }
  return value;
}

function reqCount(obj: Record<string, unknown>, key: string, path: string): number {
  const value = obj[key];
  const field = path ? `${path}.${key}` : key;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(field, "expected a non-negative integer");
  }
  return value;
}

function optCount(obj: Record<string, unknown>, key: string, path: string): number {
  if (obj[key] === undefined) return 0;
  return reqCount(obj, key, path);
}

function reqDate(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  const field = path ? `${path}.${key}` : key;
  if (typeof value !== "string" || !isValidDateString(value)) {
    fail(field, "expected a valid YYYY-MM-DD calendar date");
  }
  return value;
}

function validateCosts(value: unknown, path: string): CostInput[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  const seen = new Set<string>();
  const costs: CostInput[] = [];
  value.forEach((item, i) => {
    const p = `${path}[${i}]`;
    const obj = asObject(item, p);
    rejectUnknownKeys(obj, ["id", "date", "amountCents"], p);
    const id = reqString(obj, "id", p);
    if (seen.has(id)) fail(`${p}.id`, `duplicate id "${id}"`);
    seen.add(id);
    costs.push({ id, date: reqDate(obj, "date", p), amountCents: reqCount(obj, "amountCents", p) });
  });
  return costs;
}

function validateRule(item: unknown, path: string): PaymentRule {
  const obj = asObject(item, path);
  const id = reqString(obj, "id", path);
  const kind = obj.kind;
  const amountCents = reqCount(obj, "amountCents", path);
  switch (kind) {
    case "on_date":
      rejectUnknownKeys(obj, ["id", "kind", "amountCents", "date"], path);
      return { id, kind, amountCents, date: reqDate(obj, "date", path) };
    case "on_acceptance":
      rejectUnknownKeys(
        obj,
        ["id", "kind", "amountCents", "deliveryDate", "acceptanceWindowDays", "netDays"],
        path,
      );
      return {
        id,
        kind,
        amountCents,
        deliveryDate: reqDate(obj, "deliveryDate", path),
        acceptanceWindowDays: reqCount(obj, "acceptanceWindowDays", path),
        netDays: reqCount(obj, "netDays", path),
      };
    case "escrow_deposit":
      rejectUnknownKeys(obj, ["id", "kind", "amountCents", "date"], path);
      return { id, kind, amountCents, date: reqDate(obj, "date", path) };
    case "escrow_release": {
      rejectUnknownKeys(obj, ["id", "kind", "amountCents", "date", "requiresExtension"], path);
      const rule: PaymentRule = {
        id,
        kind,
        amountCents,
        date: reqDate(obj, "date", path),
      };
      const ext = optString(obj, "requiresExtension", path);
      if (ext !== undefined) rule.requiresExtension = ext;
      return rule;
    }
    default:
      return fail(`${path}.kind`, `unknown payment rule kind ${JSON.stringify(kind)}`);
  }
}

function validateCandidate(item: unknown, path: string): Candidate {
  const obj = asObject(item, path);
  rejectUnknownKeys(obj, ["id", "rankCents", "totalCents", "paymentRules"], path);
  const id = reqString(obj, "id", path);
  const rankCents = reqCount(obj, "rankCents", path);
  const totalCents = reqCount(obj, "totalCents", path);
  if (!Array.isArray(obj.paymentRules)) fail(`${path}.paymentRules`, "expected an array");
  const seen = new Set<string>();
  const paymentRules = (obj.paymentRules as unknown[]).map((rule, i) => {
    const validated = validateRule(rule, `${path}.paymentRules[${i}]`);
    if (seen.has(validated.id)) {
      fail(`${path}.paymentRules[${i}].id`, `duplicate id "${validated.id}"`);
    }
    seen.add(validated.id);
    return validated;
  });

  const receivable = paymentRules
    .filter(
      (rule) =>
        rule.kind === "on_date" || rule.kind === "on_acceptance" || rule.kind === "escrow_deposit",
    )
    .reduce((sum, rule) => sum + rule.amountCents, 0);
  if (receivable !== totalCents) {
    fail(
      `${path}.totalCents`,
      `payment and escrow_deposit amounts sum to ${receivable}, expected totalCents ${totalCents}`,
    );
  }

  const depositSum = paymentRules
    .filter((rule) => rule.kind === "escrow_deposit")
    .reduce((sum, rule) => sum + rule.amountCents, 0);
  const releases = paymentRules.filter((rule) => rule.kind === "escrow_release");
  const releaseSum = releases.reduce((sum, rule) => sum + rule.amountCents, 0);
  if (depositSum !== releaseSum) {
    fail(
      `${path}.paymentRules`,
      `escrow_release amounts sum to ${releaseSum}, escrow_deposit amounts sum to ${depositSum}`,
    );
  }
  const deposits = paymentRules.filter((rule) => rule.kind === "escrow_deposit");
  if (releases.length > 0 && deposits.length > 0) {
    const firstDeposit = Math.min(...deposits.map((rule) => dayNumber(rule.date)));
    for (const release of releases) {
      if (dayNumber(release.date) < firstDeposit) {
        fail(
          `${path}.paymentRules`,
          `escrow_release "${release.id}" dated ${release.date} precedes the first escrow deposit`,
        );
      }
    }
  }
  return { id, rankCents, totalCents, paymentRules };
}

function validateScenario(item: unknown, path: string): Scenario {
  const obj = asObject(item, path);
  rejectUnknownKeys(
    obj,
    ["id", "acceptanceDelayDays", "paymentLagDays", "extraCosts", "extensionsGranted"],
    path,
  );
  const id = reqString(obj, "id", path);
  const extraCosts =
    obj.extraCosts === undefined ? [] : validateCosts(obj.extraCosts, `${path}.extraCosts`);
  const granted = obj.extensionsGranted;
  if (granted !== undefined && !Array.isArray(granted)) {
    fail(`${path}.extensionsGranted`, "expected an array");
  }
  const extensionsGranted = ((granted ?? []) as unknown[]).map((entry, i) => {
    if (typeof entry !== "string" || entry.length === 0) {
      fail(`${path}.extensionsGranted[${i}]`, "expected a non-empty string");
    }
    return entry;
  });
  return {
    id,
    acceptanceDelayDays: optCount(obj, "acceptanceDelayDays", path),
    paymentLagDays: optCount(obj, "paymentLagDays", path),
    extraCosts,
    extensionsGranted,
  };
}

// Hand-written boundary validation: model output never reaches the runner
// without passing through this. Returns a normalized RunInput (scenario
// defaults applied, demoAssumptions resolved to top-level fields) or throws
// RunInputError with a path to the offending field.
export function validateRunInput(raw: unknown): RunInput {
  const obj = asObject(raw, "");
  rejectUnknownKeys(
    obj,
    [
      "label",
      "description",
      "startDate",
      "openingCents",
      "floorCents",
      "costs",
      "demoAssumptions",
      "candidates",
      "scenarios",
      "passingScenarios",
    ],
    "",
  );
  const startDate = reqDate(obj, "startDate", "");
  const label = optString(obj, "label", "");
  const description = optString(obj, "description", "");

  let openingCents: number;
  let floorCents: number;
  let costs: CostInput[];
  if (obj.demoAssumptions !== undefined) {
    for (const key of ["openingCents", "floorCents", "costs"]) {
      if (obj[key] !== undefined) {
        fail(key, "must be set inside demoAssumptions, not at top level");
      }
    }
    const demo = asObject(obj.demoAssumptions, "demoAssumptions");
    rejectUnknownKeys(demo, ["note", "openingCents", "floorCents", "costs"], "demoAssumptions");
    optString(demo, "note", "demoAssumptions");
    openingCents = reqCount(demo, "openingCents", "demoAssumptions");
    floorCents = reqCount(demo, "floorCents", "demoAssumptions");
    costs = validateCosts(demo.costs, "demoAssumptions.costs");
  } else {
    openingCents = reqCount(obj, "openingCents", "");
    floorCents = reqCount(obj, "floorCents", "");
    costs = validateCosts(obj.costs, "costs");
  }
  const costIds = new Set(costs.map((cost) => cost.id));

  if (!Array.isArray(obj.candidates)) fail("candidates", "expected an array");
  const candidates = (obj.candidates as unknown[]).map((cand, i) =>
    validateCandidate(cand, `candidates[${i}]`),
  );
  const candidateIds = new Set<string>();
  for (const cand of candidates) {
    if (candidateIds.has(cand.id)) fail("candidates", `duplicate candidate id "${cand.id}"`);
    candidateIds.add(cand.id);
    for (const rule of cand.paymentRules) {
      if (costIds.has(rule.id)) {
        fail(
          "candidates",
          `payment rule id "${rule.id}" on candidate "${cand.id}" duplicates a cost id`,
        );
      }
    }
  }

  if (!Array.isArray(obj.scenarios)) fail("scenarios", "expected an array");
  const scenarios = (obj.scenarios as unknown[]).map((scen, i) =>
    validateScenario(scen, `scenarios[${i}]`),
  );
  const scenarioIds = new Set<string>();
  for (const scen of scenarios) {
    if (scenarioIds.has(scen.id)) fail("scenarios", `duplicate scenario id "${scen.id}"`);
    scenarioIds.add(scen.id);
    for (const extra of scen.extraCosts) {
      if (costIds.has(extra.id)) {
        fail(
          `scenarios.${scen.id}.extraCosts`,
          `extra cost id "${extra.id}" duplicates a cost id`,
        );
      }
    }
    for (const cand of candidates) {
      for (const rule of cand.paymentRules) {
        if (scen.extraCosts.some((extra) => extra.id === rule.id)) {
          fail(
            `scenarios.${scen.id}.extraCosts`,
            `extra cost id "${rule.id}" duplicates a payment rule id on candidate "${cand.id}"`,
          );
        }
      }
    }
  }

  if (!Array.isArray(obj.passingScenarios)) fail("passingScenarios", "expected an array");
  const passingSeen = new Set<string>();
  const passingScenarios = (obj.passingScenarios as unknown[]).map((entry, i) => {
    if (typeof entry !== "string" || entry.length === 0) {
      fail(`passingScenarios[${i}]`, "expected a non-empty string");
    }
    if (!scenarioIds.has(entry)) {
      fail(`passingScenarios[${i}]`, `unknown scenario id "${entry}"`);
    }
    if (passingSeen.has(entry)) {
      fail(`passingScenarios[${i}]`, `duplicate scenario id "${entry}"`);
    }
    passingSeen.add(entry);
    return entry;
  });

  return {
    label,
    description,
    startDate,
    openingCents,
    floorCents,
    costs,
    candidates,
    scenarios,
    passingScenarios,
  };
}
