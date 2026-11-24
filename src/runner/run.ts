import { dateString, dayNumber, rollToBusinessDay } from "./dates.ts";
import { digestValue } from "./digest.ts";
import { validateRunInput } from "./validate.ts";
import type {
  Candidate,
  LedgerEntry,
  RunInput,
  RunOutput,
  Scenario,
  ScenarioResult,
} from "./types.ts";

export const RUNNER_VERSION = "caveat-cash-runner/1";

type PendingEvent = {
  day: number;
  order: number;
  kind: LedgerEntry["kind"];
  id: string;
  cashDeltaCents: number;
  escrowDeltaCents: number;
};

// Same-day order: outflows first (conservative) — cost (0), then the non-cash
// escrow_deposit (1), then inflows payment/escrow_release (2); ties by id.
const KIND_ORDER: Record<LedgerEntry["kind"], number> = {
  cost: 0,
  escrow_deposit: 1,
  payment: 2,
  escrow_release: 2,
};

function buildEvents(candidate: Candidate, scenario: Scenario, costs: RunInput["costs"]): PendingEvent[] {
  const events: PendingEvent[] = [];
  for (const cost of [...costs, ...scenario.extraCosts]) {
    // Costs always land on their stated date, even on a weekend.
    events.push({
      day: dayNumber(cost.date),
      order: KIND_ORDER.cost,
      kind: "cost",
      id: cost.id,
      cashDeltaCents: -cost.amountCents,
      escrowDeltaCents: 0,
    });
  }
  for (const rule of candidate.paymentRules) {
    switch (rule.kind) {
      case "on_date":
        events.push({
          day: rollToBusinessDay(dayNumber(rule.date)),
          order: KIND_ORDER.payment,
          kind: "payment",
          id: rule.id,
          cashDeltaCents: rule.amountCents,
          escrowDeltaCents: 0,
        });
        break;
      case "on_acceptance": {
        // The three delays stay separate: delivery + acceptance window +
        // scenario acceptance delay = acceptance; + netDays = due; + scenario
        // payment lag, then the weekend roll = received.
        const acceptance =
          dayNumber(rule.deliveryDate) + rule.acceptanceWindowDays + scenario.acceptanceDelayDays;
        const due = acceptance + rule.netDays;
        const received = rollToBusinessDay(due + scenario.paymentLagDays);
        events.push({
          day: received,
          order: KIND_ORDER.payment,
          kind: "payment",
          id: rule.id,
          cashDeltaCents: rule.amountCents,
          escrowDeltaCents: 0,
        });
        break;
      }
      case "escrow_deposit":
        // Escrow is not cash: no cash delta, and no weekend roll.
        events.push({
          day: dayNumber(rule.date),
          order: KIND_ORDER.escrow_deposit,
          kind: "escrow_deposit",
          id: rule.id,
          cashDeltaCents: 0,
          escrowDeltaCents: rule.amountCents,
        });
        break;
      case "escrow_release": {
        if (
          rule.requiresExtension !== undefined &&
          !scenario.extensionsGranted.includes(rule.requiresExtension)
        ) {
          break;
        }
        events.push({
          day: rollToBusinessDay(dayNumber(rule.date)),
          order: KIND_ORDER.escrow_release,
          kind: "escrow_release",
          id: rule.id,
          cashDeltaCents: rule.amountCents,
          escrowDeltaCents: -rule.amountCents,
        });
        break;
      }
    }
  }
  events.sort((a, b) => {
    if (a.day !== b.day) return a.day - b.day;
    if (a.order !== b.order) return a.order - b.order;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return events;
}

function runScenario(input: RunInput, candidate: Candidate, scenario: Scenario): ScenarioResult {
  const startDay = dayNumber(input.startDate);
  const events = buildEvents(candidate, scenario, input.costs);
  let balance = input.openingCents;
  let escrowBalance = 0;
  let firstBreach: ScenarioResult["firstBreach"] = null;
  const lowest = { date: input.startDate, balanceCents: input.openingCents };
  const ledger: LedgerEntry[] = [];
  for (const event of events) {
    balance += event.cashDeltaCents;
    escrowBalance += event.escrowDeltaCents;
    const date = dateString(event.day);
    const week = Math.floor((event.day - startDay) / 7) + 1;
    ledger.push({
      date,
      kind: event.kind,
      id: event.id,
      cashDeltaCents: event.cashDeltaCents,
      escrowDeltaCents: event.escrowDeltaCents,
      balanceCents: balance,
      escrowBalanceCents: escrowBalance,
      week,
    });
    if (balance < lowest.balanceCents) {
      lowest.date = date;
      lowest.balanceCents = balance;
    }
    // The floor is evaluated after every event; equality is not a breach.
    if (balance < input.floorCents && firstBreach === null) {
      firstBreach = { date, week, balanceCents: balance };
    }
  }
  return {
    passes: firstBreach === null,
    firstBreach,
    lowest,
    endBalanceCents: balance,
    endEscrowCents: escrowBalance,
    ledger,
  };
}

export function runFixture(raw: unknown): RunOutput {
  const input = validateRunInput(raw);
  const scenariosById = new Map(input.scenarios.map((scen) => [scen.id, scen]));
  const results: Record<string, Record<string, ScenarioResult>> = {};
  for (const candidate of input.candidates) {
    const perScenario: Record<string, ScenarioResult> = {};
    for (const scenarioId of input.passingScenarios) {
      const scenario = scenariosById.get(scenarioId);
      if (!scenario) throw new Error(`validated scenario id missing: ${scenarioId}`);
      perScenario[scenarioId] = runScenario(input, candidate, scenario);
    }
    results[candidate.id] = perScenario;
  }
  let smallestPassingCandidate: string | null = null;
  let smallestRank = Infinity;
  for (const candidate of input.candidates) {
    const perScenario = results[candidate.id];
    const allPass =
      perScenario !== undefined &&
      input.passingScenarios.every((scenarioId) => perScenario[scenarioId]?.passes === true);
    if (allPass && candidate.rankCents < smallestRank) {
      smallestRank = candidate.rankCents;
      smallestPassingCandidate = candidate.id;
    }
  }
  return {
    runnerVersion: RUNNER_VERSION,
    inputDigest: digestValue(raw),
    results,
    smallestPassingCandidate,
    resultDigest: digestValue({ results, smallestPassingCandidate }),
  };
}
