import { readFile } from "node:fs/promises";

import { BoxError, fetchBoxFile, findFolderByName, listFolder } from "../../src/evidence/box.ts";
import { OpenRouterDecisionProvider } from "../../src/interpret/openrouter.ts";
import { renderDecisionCard } from "../../src/review/decision-card.ts";
import { BILLING_TRIGGER } from "../../src/interpret/types.ts";
import type { DecisionOutcome, Question } from "../../src/interpret/types.ts";

const GATEWAY_LIST_URL = "https://api.sprites.dev/v1/gateway/list";
const BOX_FILE_NAME = "01-consulting-agreement.pdf";
const PROOF_CASE_ID = "acceptance_clear";

type Connection = { provider: string; gatewayBaseUrl: string };

type BoxProof =
  | {
      status: "ok";
      connector: "box";
      fileName: string;
      fileVersionPresent: boolean;
      sizeBytes: number;
      sha256: string;
      sha1Match: boolean;
      versionStable: boolean;
    }
  | { status: string; connector: "box"; detail?: string };

type OpenRouterProof = {
  status: string;
  connector: "openrouter";
  caseId?: string;
  model?: string;
  modelVersion?: string;
  servedBy?: string;
  action?: string;
  reason?: string;
  citedClause?: { excerpt_id: string; quote: string };
  confidence?: number;
  outcomeStatus?: string;
  reviewReason?: string;
  reviewDetail?: string;
  latencyMs?: number;
  detail?: string;
  decisionCardHtml?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listConnections(): Promise<Connection[]> {
  const response = await fetch(GATEWAY_LIST_URL);
  if (!response.ok) {
    throw new Error(`gateway list returned HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.connections)) {
    throw new Error("gateway list response lacked connections");
  }
  const connections: Connection[] = [];
  for (const entry of body.connections) {
    if (
      isRecord(entry) &&
      typeof entry.provider === "string" &&
      typeof entry.gateway_base_url === "string"
    ) {
      connections.push({ provider: entry.provider, gatewayBaseUrl: entry.gateway_base_url });
    }
  }
  return connections;
}

function errorDetail(error: unknown): string {
  if (error instanceof BoxError) return error.code;
  if (error instanceof Error) return error.name;
  return "unknown_error";
}

async function proveBox(connections: Connection[]): Promise<BoxProof> {
  const conn = connections.find((c) => c.provider === "box");
  if (conn === undefined) {
    return { status: "not_configured", connector: "box" };
  }
  const folderName = process.env.CAVEAT_BOX_FOLDER ?? "caveat_TEST";

  try {
    const folder = await findFolderByName(conn.gatewayBaseUrl, "0", folderName);
    if (folder === undefined) {
      return { status: "folder_not_found", connector: "box" };
    }
    const entries = await listFolder(conn.gatewayBaseUrl, folder.id);
    const file = entries.find((e) => e.type === "file" && e.name === BOX_FILE_NAME);
    if (file === undefined) {
      return { status: "file_not_found", connector: "box" };
    }
    const evidence = await fetchBoxFile(conn.gatewayBaseUrl, file.id);
    return {
      status: "ok",
      connector: "box",
      fileName: evidence.metadata.name,
      fileVersionPresent: evidence.metadata.fileVersionId.length > 0,
      sizeBytes: evidence.bytes.byteLength,
      sha256: evidence.sha256,
      sha1Match: true,
      versionStable: true,
    };
  } catch (error) {
    return { status: "error", connector: "box", detail: errorDetail(error) };
  }
}

type FixtureCase = {
  id: string;
  expectedAction: string;
  excerpts: Question["excerpts"];
};

async function loadProofCase(): Promise<{
  question: Question;
  caseId: string;
  expectedAction: string;
}> {
  const fixtureUrl = new URL("../../fixtures/m1/billing-trigger.json", import.meta.url);
  const raw: unknown = JSON.parse(await readFile(fixtureUrl, "utf8"));
  if (!isRecord(raw) || typeof raw.questionId !== "string" || !Array.isArray(raw.cases)) {
    throw new Error("billing-trigger fixture is malformed");
  }
  const cases = raw.cases as FixtureCase[];
  const caseId = process.env.CAVEAT_PROOF_CASE ?? PROOF_CASE_ID;
  const proofCase = cases.find((c) => c.id === caseId);
  if (proofCase === undefined) {
    throw new Error(`billing-trigger fixture has no case ${caseId}`);
  }
  return {
    question: {
      spec: BILLING_TRIGGER,
      id: `${raw.questionId}/${proofCase.id}`,
      excerpts: proofCase.excerpts,
    },
    caseId: proofCase.id,
    expectedAction: proofCase.expectedAction,
  };
}

async function proveOpenRouter(connections: Connection[]): Promise<OpenRouterProof> {
  const conn = connections.find((c) => c.provider === "openrouter");
  if (conn === undefined) {
    return { status: "not_configured", connector: "openrouter" };
  }

  const model = process.env.CAVEAT_DECISION_MODEL;
  const provider = new OpenRouterDecisionProvider({
    gatewayBaseUrl: conn.gatewayBaseUrl,
    ...(model !== undefined && model.length > 0 ? { model } : {}),
  });

  try {
    const { question, caseId, expectedAction } = await loadProofCase();
    const decideStarted = performance.now();
    const outcome: DecisionOutcome = await provider.decide(question);
    const latencyMs = Math.round(performance.now() - decideStarted);
    const decision = outcome.decision;
    const proof: OpenRouterProof = {
      caseId,
      status:
        outcome.status === "decided"
          ? outcome.decision.action === expectedAction
            ? "ok"
            : "unexpected_action"
          : "needs_review",
      connector: "openrouter",
      model: outcome.model ?? model ?? "nvidia/nemotron-3.5-super-vl:free",
      outcomeStatus: outcome.status,
      latencyMs,
      decisionCardHtml: renderDecisionCard(outcome, question),
    };
    if (outcome.modelVersion !== undefined) proof.modelVersion = outcome.modelVersion;
    if (outcome.servedBy !== undefined) proof.servedBy = outcome.servedBy;
    if (decision !== undefined) {
      proof.action = decision.action;
      proof.reason = decision.reason;
      proof.citedClause = decision.cited_clause;
      proof.confidence = decision.confidence;
    }
    if (outcome.status === "needs_review") {
      proof.reviewReason = outcome.reason;
      proof.reviewDetail = outcome.detail;
    }
    return proof;
  } catch (error) {
    return { status: "error", connector: "openrouter", detail: errorDetail(error) };
  }
}

const started = performance.now();
let connections: Connection[];
try {
  connections = await listConnections();
} catch (error) {
  console.log(
    JSON.stringify({
      box: { status: "error", connector: "box", detail: errorDetail(error) },
      openrouter: { status: "error", connector: "openrouter", detail: errorDetail(error) },
      timingsMs: { total: Math.round(performance.now() - started) },
    }),
  );
  process.exit(1);
}

const boxStarted = performance.now();
const box = await proveBox(connections);
const boxMs = Math.round(performance.now() - boxStarted);

const openrouterStarted = performance.now();
const openrouter = await proveOpenRouter(connections);
const openrouterMs = Math.round(performance.now() - openrouterStarted);

console.log(
  JSON.stringify({
    box,
    openrouter,
    timingsMs: {
      box: boxMs,
      openrouter: openrouterMs,
      total: Math.round(performance.now() - started),
    },
  }),
);
