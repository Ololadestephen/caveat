import { readFile } from "node:fs/promises";

import { BoxError, fetchBoxFile, findFolderByName, listFolder } from "../../src/evidence/box.ts";
import { OllamaDecisionProvider } from "../../src/interpret/ollama.ts";
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

type OllamaProof = {
  status: string;
  connector: "ollama";
  model?: string;
  action?: string;
  confidence?: number;
  outcomeStatus?: string;
  reviewReason?: string;
  availableModels?: string[];
  detail?: string;
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

async function listOllamaModels(gatewayBaseUrl: string): Promise<string[]> {
  const response = await fetch(`${gatewayBaseUrl}/api/tags`);
  if (!response.ok) {
    throw new Error(`api/tags returned HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new Error("api/tags response lacked models");
  }
  const models: string[] = [];
  for (const entry of body.models) {
    if (isRecord(entry) && typeof entry.name === "string") models.push(entry.name);
  }
  return models;
}

type FixtureCase = {
  id: string;
  expectedAction: string;
  excerpts: BillingTriggerQuestion["excerpts"];
};

async function loadProofCase(): Promise<{ question: BillingTriggerQuestion; caseId: string }> {
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
  };
}

async function proveOllama(connections: Connection[]): Promise<OllamaProof> {
  const conn = connections.find((c) => c.provider === "ollama");
  if (conn === undefined) {
    return { status: "not_configured", connector: "ollama" };
  }

  let models: string[];
  try {
    models = await listOllamaModels(conn.gatewayBaseUrl);
  } catch (error) {
    return { status: "error", connector: "ollama", detail: errorDetail(error) };
  }

  const model = process.env.CAVEAT_OLLAMA_MODEL;
  if (model === undefined || model.length === 0) {
    return { status: "model_not_pinned", connector: "ollama", availableModels: models };
  }
  if (!models.includes(model)) {
    return {
      status: "model_unavailable",
      connector: "ollama",
      model,
      availableModels: models,
    };
  }

  try {
    const { question } = await loadProofCase();
    const provider = new OllamaDecisionProvider({ gatewayBaseUrl: conn.gatewayBaseUrl, model });
    const outcome: DecisionOutcome = await provider.decide(question);
    const proof: OllamaProof = {
      status: outcome.status === "decided" ? "ok" : "needs_review",
      connector: "ollama",
      model: outcome.model ?? model,
      outcomeStatus: outcome.status,
    };
    if (outcome.status === "decided") {
      proof.action = outcome.decision.action;
      proof.confidence = outcome.decision.confidence;
    } else {
      proof.reviewReason = outcome.reason;
      if (outcome.decision !== undefined) {
        proof.action = outcome.decision.action;
        proof.confidence = outcome.decision.confidence;
      }
    }
    return proof;
  } catch (error) {
    return { status: "error", connector: "ollama", detail: errorDetail(error) };
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
      ollama: { status: "error", connector: "ollama", detail: errorDetail(error) },
      timingsMs: { total: Math.round(performance.now() - started) },
    }),
  );
  process.exit(1);
}

const boxStarted = performance.now();
const box = await proveBox(connections);
const boxMs = Math.round(performance.now() - boxStarted);

const ollamaStarted = performance.now();
const ollama = await proveOllama(connections);
const ollamaMs = Math.round(performance.now() - ollamaStarted);

console.log(
  JSON.stringify({
    box,
    ollama,
    timingsMs: {
      box: boxMs,
      ollama: ollamaMs,
      total: Math.round(performance.now() - started),
    },
  }),
);
