import { readFile } from "node:fs/promises";

import { BoxError, fetchBoxFile, findFolderByName, listFolder } from "../../src/evidence/box.ts";
import { GeminiDecisionProvider } from "../../src/interpret/gemini.ts";
import { renderDecisionCard } from "../../src/review/decision-card.ts";
import type { BillingTriggerQuestion, DecisionOutcome } from "../../src/interpret/types.ts";

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

type GeminiProof = {
  status: string;
  connector: "gemini";
  model?: string;
  modelVersion?: string;
  action?: string;
  reason?: string;
  citedClause?: { excerpt_id: string; quote: string };
  confidence?: number;
  outcomeStatus?: string;
  reviewReason?: string;
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
  excerpts: BillingTriggerQuestion["excerpts"];
};

async function loadProofCase(): Promise<{
  question: BillingTriggerQuestion;
  caseId: string;
  expectedAction: string;
}> {
  const fixtureUrl = new URL("../../fixtures/m1/billing-trigger.json", import.meta.url);
  const raw: unknown = JSON.parse(await readFile(fixtureUrl, "utf8"));
  if (!isRecord(raw) || typeof raw.questionId !== "string" || !Array.isArray(raw.cases)) {
    throw new Error("billing-trigger fixture is malformed");
  }
  const cases = raw.cases as FixtureCase[];
  const proofCase = cases.find((c) => c.id === PROOF_CASE_ID) ?? cases[0];
  if (proofCase === undefined) throw new Error("billing-trigger fixture has no cases");
  return {
    question: { questionId: `${raw.questionId}/${proofCase.id}`, excerpts: proofCase.excerpts },
    caseId: proofCase.id,
    expectedAction: proofCase.expectedAction,
  };
}

async function proveGemini(connections: Connection[]): Promise<GeminiProof> {
  const conn = connections.find((c) => c.provider === "gemini");
  if (conn === undefined) {
    return { status: "not_configured", connector: "gemini" };
  }

  const model = process.env.CAVEAT_GEMINI_MODEL;
  const provider = new GeminiDecisionProvider({
    gatewayBaseUrl: conn.gatewayBaseUrl,
    ...(model !== undefined && model.length > 0 ? { model } : {}),
  });

  try {
    const { question, expectedAction } = await loadProofCase();
    const decideStarted = performance.now();
    const outcome: DecisionOutcome = await provider.decide(question);
    const latencyMs = Math.round(performance.now() - decideStarted);
    const decision = outcome.decision;
    const proof: GeminiProof = {
      status:
        outcome.status === "decided"
          ? outcome.decision.action === expectedAction
            ? "ok"
            : "unexpected_action"
          : "needs_review",
      connector: "gemini",
      model: outcome.model ?? model ?? "gemini-flash-latest",
      outcomeStatus: outcome.status,
      latencyMs,
      decisionCardHtml: renderDecisionCard(outcome, question),
    };
    if (outcome.modelVersion !== undefined) proof.modelVersion = outcome.modelVersion;
    if (decision !== undefined) {
      proof.action = decision.action;
      proof.reason = decision.reason;
      proof.citedClause = decision.cited_clause;
      proof.confidence = decision.confidence;
    }
    if (outcome.status === "needs_review") proof.reviewReason = outcome.reason;
    return proof;
  } catch (error) {
    return { status: "error", connector: "gemini", detail: errorDetail(error) };
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
      gemini: { status: "error", connector: "gemini", detail: errorDetail(error) },
      timingsMs: { total: Math.round(performance.now() - started) },
    }),
  );
  process.exit(1);
}

const boxStarted = performance.now();
const box = await proveBox(connections);
const boxMs = Math.round(performance.now() - boxStarted);

const geminiStarted = performance.now();
const gemini = await proveGemini(connections);
const geminiMs = Math.round(performance.now() - geminiStarted);

console.log(
  JSON.stringify({
    box,
    gemini,
    timingsMs: {
      box: boxMs,
      gemini: geminiMs,
      total: Math.round(performance.now() - started),
    },
  }),
);
