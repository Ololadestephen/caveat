export type CostInput = {
  id: string;
  date: string;
  amountCents: number;
};

export type PaymentRule =
  | { id: string; kind: "on_date"; amountCents: number; date: string }
  | {
      id: string;
      kind: "on_acceptance";
      amountCents: number;
      deliveryDate: string;
      acceptanceWindowDays: number;
      netDays: number;
    }
  | { id: string; kind: "escrow_deposit"; amountCents: number; date: string }
  | {
      id: string;
      kind: "escrow_release";
      amountCents: number;
      date: string;
      requiresExtension?: string;
    };

export type Candidate = {
  id: string;
  rankCents: number;
  totalCents: number;
  paymentRules: PaymentRule[];
};

export type Scenario = {
  id: string;
  acceptanceDelayDays: number;
  paymentLagDays: number;
  extraCosts: CostInput[];
  extensionsGranted: string[];
};

export type RunInput = {
  label: string | undefined;
  description: string | undefined;
  startDate: string;
  openingCents: number;
  floorCents: number;
  costs: CostInput[];
  candidates: Candidate[];
  scenarios: Scenario[];
  passingScenarios: string[];
};

export type LedgerEntry = {
  date: string;
  kind: "cost" | "payment" | "escrow_deposit" | "escrow_release";
  id: string;
  cashDeltaCents: number;
  escrowDeltaCents: number;
  balanceCents: number;
  escrowBalanceCents: number;
  week: number;
};

export type ScenarioResult = {
  passes: boolean;
  firstBreach: { date: string; week: number; balanceCents: number } | null;
  lowest: { date: string; balanceCents: number };
  endBalanceCents: number;
  endEscrowCents: number;
  ledger: LedgerEntry[];
};

export type RunOutput = {
  runnerVersion: string;
  inputDigest: string;
  results: Record<string, Record<string, ScenarioResult>>;
  smallestPassingCandidate: string | null;
  resultDigest: string;
};
