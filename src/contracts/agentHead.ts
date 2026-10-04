import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import { continuationEchoFromApi, normalizeNextTask, type ContinuationEcho } from "./continuation.js";
import {
  getAgentHeadDocParamsSchema,
  getAgentHeadParamsSchema,
  HEAD_IDENTITY_FIELD_LABELS,
  HEAD_IDENTITY_FIELD_TO_API,
  HEAD_IDENTITY_MODE_TO_API,
  identityFieldFromApi,
  identityModeFromApi,
  normalizeIdentityField,
  normalizeIdentityMode,
  normalizeIdentitySection,
  proposeHeadChangeInputSchema,
  type HeadIdentityField,
  type HeadIdentityMode,
  type HeadProposalKind,
  type ProposeHeadChangeInput
} from "../schemas/agentHead.js";

/**
 * Cabeça do PRÓPRIO agente (rodada 5, 01/10).
 *
 *  - `getAgentHead`: GET /agent/:id/head?step_ref=…&index=1 → índice (arquivos,
 *    modelos, playbooks, propostas pendentes). O conteúdo NÃO vem para a saída do
 *    kit: o `composed_markdown` já está no prompt do run e um modelo tem até 30 KB.
 *  - `getAgentHeadDoc`: GET /agent/:id/head/doc/:docId → UM arquivo inteiro (o
 *    comando grava no `--out`).
 *  - `proposeHeadChange`: POST /agent-head-proposal → cria o PEDIDO de aprovação
 *    no servidor (o agente sai do token). Nada muda na cabeça sem o dono aprovar.
 *    Rodada 7: `kind 'identidade'` (missão, escopo, políticas, regras) manda
 *    `field`/`mode` no nome do back (o kit traduz do pt).
 *
 * Quem lê: token de run só do próprio agente (outro agente = 403), o bot do
 * agente e humano com papel A/U. Outra empresa = 404.
 */

/**
 * Tipo do arquivo da cabeça. Rodada 6: `referencia` = doc de consulta (arquivo
 * grande que o Construtor deixou FORA da cabeça; lido sob demanda com `agent head doc`).
 */
export type HeadDocKind = "doc" | "modelo" | "referencia";

export interface HeadIndexDoc {
  id: string;
  name: string;
  kind: HeadDocKind;
  description: string | null;
  includeInHead: boolean;
  bytes: number | null;
}

export interface HeadIndexPlaybook {
  stepRef: string;
  title: string | null;
  version: number | null;
  bytes: number | null;
}

export interface HeadIndexProposal {
  proposalId: number;
  kind: string | null;
  summary: string | null;
  createdAt: string | null;
}

export interface AgentHeadIndex {
  agentId: number;
  agentName: string | null;
  /** null = back sem `head_index` (antes da rodada 5): não dá para saber. */
  selfImproveEnabled: boolean | null;
  docs: HeadIndexDoc[];
  models: HeadIndexDoc[];
  /** Rodada 6: docs de consulta (fora da cabeça; ler com `agent head doc --id`). */
  references: HeadIndexDoc[];
  /** null = back sem `head_index` (a lista de playbooks não veio). */
  playbooks: HeadIndexPlaybook[] | null;
  pendingProposals: HeadIndexProposal[];
  memoryDocsHash: string | null;
  readModelCommand: string;
  /** O back mandou o índice (`head_index`)? false = montado do `memory_docs` (back antigo). */
  fromServerIndex: boolean;
}

export interface AgentHeadDoc {
  agentId: number;
  id: string;
  name: string | null;
  kind: HeadDocKind;
  description: string | null;
  includeInHead: boolean;
  content: string;
  bytes: number;
  sha256: string | null;
}

export interface HeadProposalResult {
  proposalId: number | null;
  approvalId: number | null;
  status: string | null;
  deduped: boolean;
  kind: HeadProposalKind | string | null;
  summary: string | null;
  target: { docKey: string | null; docId: string | null; name: string | null; exists: boolean } | null;
  origin: string | null;
  routedTo: { userId: number; name: string | null } | null;
  diff: { added: number | null; removed: number | null } | null;
  bytes: { before: number | null; after: number | null } | null;
  flags: Array<{ code: string; message: string }>;
  contentSha: string | null;
  /** Rodada 7: a aprovação pode ser feita inline na conversa (origem pedido humano). null = back antigo. */
  inlineAllowed: boolean | null;
  /** Rodada 7: quem pediu na conversa é aprovador do agente (só na criação). null = não veio. */
  requesterCanApprove: boolean | null;
  /**
   * Rodada 7: só em `identidade`; campo e modo no nome do KIT (pt). `section` (A1 do
   * E2E) = o título como está no texto, onde o acréscimo entra; null = fim do texto.
   */
  identity: {
    field: HeadIdentityField | null;
    fieldLabel: string | null;
    mode: HeadIdentityMode | null;
    section: string | null;
  } | null;
  /** Rodada 8 (kit-2/kit-7): o back confirma se guardou a continuação e se é desta conversa. null = back sem o eco. */
  continuation: ContinuationEcho | null;
}

export const READ_MODEL_COMMAND = "cange agent head doc --id <id> --out <arquivo>";

export interface AgentHeadContracts {
  getAgentHead: (input: { agentId: number; stepRef?: string }) => Promise<AgentHeadIndex & { raw: unknown }>;
  getAgentHeadDoc: (input: { agentId: number; docId: string }) => Promise<AgentHeadDoc & { raw: unknown }>;
  proposeHeadChange: (input: ProposeHeadChangeInput) => Promise<HeadProposalResult & { raw: unknown }>;
}

export function createAgentHeadContracts(client: CangeClient): AgentHeadContracts {
  return {
    async getAgentHead(input) {
      const parsed = getAgentHeadParamsSchema.safeParse({ agentId: input.agentId, stepRef: input.stepRef ?? "automation" });
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getAgentHead.", { details: parsed.error.format() });
      }
      const raw = await client.get<unknown>(`/agent/${parsed.data.agentId}/head`, {
        query: { step_ref: parsed.data.stepRef, index: 1 }
      });
      return { raw, ...normalizeHeadIndex(raw, parsed.data.agentId) };
    },

    async getAgentHeadDoc(input) {
      const parsed = getAgentHeadDocParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getAgentHeadDoc.", { details: parsed.error.format() });
      }
      const raw = await client.get<unknown>(
        `/agent/${parsed.data.agentId}/head/doc/${encodeURIComponent(parsed.data.docId)}`
      );
      const r = record(raw);
      const doc = record(r.doc);
      const content = typeof doc.content === "string" ? doc.content : "";
      const kind = headDocKindOf(doc.kind);
      return {
        raw,
        agentId: numberOrNull(r.agent_id) ?? parsed.data.agentId,
        id: stringOrNull(doc.id) ?? parsed.data.docId,
        name: stringOrNull(doc.name),
        kind,
        description: stringOrNull(doc.description),
        includeInHead: isOnDemandKind(kind) ? false : doc.include_in_head !== false,
        content,
        bytes: numberOrNull(doc.bytes) ?? Buffer.byteLength(content, "utf8"),
        sha256: stringOrNull(doc.sha256)
      };
    },

    async proposeHeadChange(input) {
      const parsed = proposeHeadChangeInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError(`Proposta inválida: ${describeProposalIssues(parsed.error.issues)}`, {
          details: parsed.error.format()
        });
      }
      const data = parsed.data;
      // Rodada 8 (D5): tarefa seguinte (uma linha); o back guarda só quando o run é de conversa.
      const then = normalizeNextTask(data.then);
      if (data.kind === "identidade") {
        // O schema já garantiu field/mode válidos; aqui só traduz pt → back.
        const field = normalizeIdentityField(data.field) as HeadIdentityField;
        const mode = normalizeIdentityMode(data.mode) ?? "acrescentar";
        // A1 do E2E: título da seção (sem os #) onde o acréscimo entra.
        const section = normalizeIdentitySection(data.section);
        const raw = await client.post<unknown>("/agent-head-proposal", {
          body: {
            kind: "identidade",
            field: HEAD_IDENTITY_FIELD_TO_API[field],
            mode: HEAD_IDENTITY_MODE_TO_API[mode],
            content: data.content,
            reason: data.reason.trim(),
            ...(section ? { section } : {}),
            ...(then ? { then } : {})
          },
          retry: false
        });
        return { raw, ...normalizeProposalResult(raw) };
      }
      const name = data.name?.trim();
      const description = data.description?.trim();
      const stepRef = data.stepRef?.trim();
      // Sem retry: criar a proposta não é idempotente do lado do kit (o back
      // deduplica pelo sha do conteúdo, mas repetir só gasta o limite do run).
      const raw = await client.post<unknown>("/agent-head-proposal", {
        body: {
          kind: data.kind,
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
          content: data.content,
          ...(data.kind === "playbook" && stepRef ? { step_ref: stepRef } : {}),
          reason: data.reason.trim(),
          ...(data.sourceArtifactId !== undefined ? { source_artifact_id: data.sourceArtifactId } : {}),
          ...(then ? { then } : {})
        },
        retry: false
      });
      return { raw, ...normalizeProposalResult(raw) };
    }
  };
}

/** Problemas do schema da proposta como frases de flag, sem repetir. */
export function describeProposalIssues(issues: ReadonlyArray<{ message: string }>): string {
  return `${[...new Set(issues.map((issue) => issue.message))].join("; ")}.`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v) => v && typeof v === "object" && !Array.isArray(v)).map(record) : [];
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Espelha o `docKindOf` do back (headIndex.ts): kind desconhecido = doc. */
export function headDocKindOf(kind: unknown): HeadDocKind {
  if (kind === "modelo") return "modelo";
  if (kind === "referencia") return "referencia";
  return "doc";
}

/** Espelha o `isOnDemandKind` do back: modelo e consulta nunca entram inlinados. */
function isOnDemandKind(kind: HeadDocKind): boolean {
  return kind === "modelo" || kind === "referencia";
}

function normalizeIndexDoc(raw: Record<string, unknown>): HeadIndexDoc | null {
  const id = stringOrNull(raw.id);
  if (!id) return null;
  const kind = headDocKindOf(raw.kind);
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "",
    kind,
    description: stringOrNull(raw.description),
    includeInHead: isOnDemandKind(kind) ? false : raw.include_in_head !== false,
    bytes: numberOrNull(raw.bytes) ?? (typeof raw.content === "string" ? Buffer.byteLength(raw.content, "utf8") : null)
  };
}

/** `memory_docs` do agente (JSON) → docs do índice, para back sem `head_index`. */
function docsFromMemoryDocs(memoryDocs: unknown): HeadIndexDoc[] {
  let parsed: unknown = memoryDocs;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return list(parsed)
    .filter((d) => typeof d.content === "string")
    .map(normalizeIndexDoc)
    .filter((d): d is HeadIndexDoc => d !== null);
}

export function normalizeHeadIndex(raw: unknown, agentId: number): AgentHeadIndex {
  const r = record(raw);
  const agent = record(r.agent);
  const index = r.head_index && typeof r.head_index === "object" ? record(r.head_index) : null;
  const base = {
    agentId: numberOrNull(agent.id) ?? agentId,
    agentName: stringOrNull(agent.name),
    readModelCommand: READ_MODEL_COMMAND
  };
  if (!index) {
    const docs = docsFromMemoryDocs(agent.memory_docs);
    return {
      ...base,
      selfImproveEnabled: null,
      docs: docs.filter((d) => d.kind === "doc"),
      models: docs.filter((d) => d.kind === "modelo"),
      references: docs.filter((d) => d.kind === "referencia"),
      playbooks: null,
      pendingProposals: [],
      memoryDocsHash: null,
      fromServerIndex: false
    };
  }
  // Rodada 6: o back manda os docs de consulta SÓ em `references` (kind 'referencia').
  const docs = [...list(index.docs), ...list(index.models), ...list(index.references)]
    .map(normalizeIndexDoc)
    .filter((d): d is HeadIndexDoc => d !== null);
  return {
    ...base,
    selfImproveEnabled: typeof index.self_improve_enabled === "boolean" ? index.self_improve_enabled : null,
    docs: docs.filter((d) => d.kind === "doc"),
    models: docs.filter((d) => d.kind === "modelo"),
    references: docs.filter((d) => d.kind === "referencia"),
    playbooks: list(index.playbooks)
      .filter((p) => typeof p.step_ref === "string" && p.step_ref.length > 0)
      .map((p) => ({
        stepRef: p.step_ref as string,
        title: stringOrNull(p.title),
        version: numberOrNull(p.version),
        bytes: numberOrNull(p.bytes)
      })),
    pendingProposals: list(index.pending_proposals)
      .map((p) => ({
        proposalId: numberOrNull(p.proposal_id) ?? 0,
        kind: stringOrNull(p.kind),
        summary: stringOrNull(p.summary),
        createdAt: stringOrNull(p.dt_created)
      }))
      .filter((p) => p.proposalId > 0),
    memoryDocsHash: stringOrNull(index.memory_docs_hash),
    readModelCommand: stringOrNull(index.read_model_command) ?? READ_MODEL_COMMAND,
    fromServerIndex: true
  };
}

export function normalizeProposalResult(raw: unknown): HeadProposalResult {
  const r = record(raw);
  const target = r.target && typeof r.target === "object" ? record(r.target) : null;
  const routed = r.routed_to_user && typeof r.routed_to_user === "object" ? record(r.routed_to_user) : null;
  const routedId = routed ? numberOrNull(routed.id_user) : null;
  const diff = r.diff && typeof r.diff === "object" ? record(r.diff) : null;
  const bytes = r.bytes && typeof r.bytes === "object" ? record(r.bytes) : null;
  const identityRaw = r.identity && typeof r.identity === "object" ? record(r.identity) : null;
  // Back sem `identity` mas com kind identidade: o campo sai do target.doc_key.
  const identityField = identityRaw
    ? identityFieldFromApi(identityRaw.field)
    : r.kind === "identidade" && target
      ? identityFieldFromApi(target.doc_key)
      : null;
  const identity =
    identityRaw || r.kind === "identidade"
      ? {
          field: identityField,
          fieldLabel:
            stringOrNull(identityRaw?.field_label) ?? (identityField ? HEAD_IDENTITY_FIELD_LABELS[identityField] : null),
          mode: identityRaw ? identityModeFromApi(identityRaw.mode) : null,
          section: stringOrNull(identityRaw?.section)
        }
      : null;
  return {
    proposalId: numberOrNull(r.proposal_id),
    approvalId: numberOrNull(r.approval_id) ?? numberOrNull(r.proposal_id),
    status: stringOrNull(r.status),
    deduped: r.deduped === true,
    kind: stringOrNull(r.kind),
    summary: stringOrNull(r.summary),
    target: target
      ? {
          docKey: stringOrNull(target.doc_key),
          docId: stringOrNull(target.doc_id),
          name: stringOrNull(target.name),
          exists: target.exists === true
        }
      : null,
    origin: stringOrNull(r.origin),
    routedTo: routedId !== null ? { userId: routedId, name: stringOrNull(routed!.name) } : null,
    diff: diff ? { added: numberOrNull(diff.added), removed: numberOrNull(diff.removed) } : null,
    bytes: bytes ? { before: numberOrNull(bytes.before), after: numberOrNull(bytes.after) } : null,
    flags: list(r.flags)
      .filter((f) => typeof f.code === "string")
      .map((f) => ({ code: f.code as string, message: typeof f.message === "string" ? f.message : "" })),
    contentSha: stringOrNull(r.content_sha),
    inlineAllowed: typeof r.inline_allowed === "boolean" ? r.inline_allowed : null,
    requesterCanApprove: typeof r.requester_can_approve === "boolean" ? r.requester_can_approve : null,
    identity,
    continuation: continuationEchoFromApi(r.continuation)
  };
}
