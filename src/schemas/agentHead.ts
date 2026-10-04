import { z } from "zod";

import { nextTaskIssue } from "../contracts/continuation.js";

/**
 * Auto-aperfeiçoamento do agente (rodada 5, 01/10): o agente LÊ a própria cabeça
 * (índice + um modelo por vez) e PROPÕE mudanças nela. Quem aplica é o dono do
 * agente, na aprovação (`POST /agent-head-proposal/:id/approve`, rota humana).
 *
 * As regras abaixo ESPELHAM o back (`wendata-back/.../AgentHeadProposal/headProposal.ts`,
 * `HEAD_PROPOSAL_LIMITS` e `PLAYBOOK_STEP_REF_RE`): o kit recusa antes de chamar a
 * API o que o back recusaria com 422, com a mesma frase de flag. O back continua
 * sendo a autoridade (lint de segredo, script, CPF/CNPJ e dado de cliente é só lá).
 */
export const HEAD_PROPOSAL_KINDS = ["modelo", "aprendizado", "playbook", "identidade"] as const;
export type HeadProposalKind = (typeof HEAD_PROPOSAL_KINDS)[number];

/**
 * Rodada 7 (02/10, decisão 2 do Matheus): `identidade` propõe mudar missão, escopo,
 * políticas ou regras de execução. Só vale quando uma PESSOA pediu na conversa (o
 * back recusa com 422 IDENTITY_REQUIRES_HUMAN_REQUEST fora disso). O kit fala pt
 * (`--field missao|escopo|politicas|regras`, `--mode acrescentar|substituir`) e
 * traduz para o contrato do back (`mission|scope|policies|policy_rules`,
 * `append|replace`).
 */
export const HEAD_IDENTITY_FIELDS = ["missao", "escopo", "politicas", "regras"] as const;
export type HeadIdentityField = (typeof HEAD_IDENTITY_FIELDS)[number];
export type HeadIdentityApiField = "mission" | "scope" | "policies" | "policy_rules";

export const HEAD_IDENTITY_FIELD_TO_API: Readonly<Record<HeadIdentityField, HeadIdentityApiField>> = Object.freeze({
  missao: "mission",
  escopo: "scope",
  politicas: "policies",
  regras: "policy_rules"
});

/** Rótulo que o usuário vê (o mesmo da aba Cabeça e do `field_label` do back). */
export const HEAD_IDENTITY_FIELD_LABELS: Readonly<Record<HeadIdentityField, string>> = Object.freeze({
  missao: "Missão",
  escopo: "Escopo",
  politicas: "Políticas",
  regras: "Regras de execução"
});

export const HEAD_IDENTITY_MODES = ["acrescentar", "substituir"] as const;
export type HeadIdentityMode = (typeof HEAD_IDENTITY_MODES)[number];
export type HeadIdentityApiMode = "append" | "replace";

export const HEAD_IDENTITY_MODE_TO_API: Readonly<Record<HeadIdentityMode, HeadIdentityApiMode>> = Object.freeze({
  acrescentar: "append",
  substituir: "replace"
});

function fold(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * `--field` → nome do kit. Aceita com ou sem acento ("missão", "políticas") e o
 * nome do back (`mission`, `policy_rules`), para o agente não errar por grafia.
 * Desconhecido → undefined.
 */
export function normalizeIdentityField(raw: string | undefined): HeadIdentityField | undefined {
  if (raw === undefined) return undefined;
  const value = fold(raw);
  if ((HEAD_IDENTITY_FIELDS as readonly string[]).includes(value)) return value as HeadIdentityField;
  const fromApi = (Object.entries(HEAD_IDENTITY_FIELD_TO_API) as Array<[HeadIdentityField, string]>).find(
    ([, api]) => api === value
  );
  if (fromApi) return fromApi[0];
  if (value === "regras de execucao" || value === "regras_de_execucao" || value === "policy-rules") return "regras";
  return undefined;
}

/** `--mode` → nome do kit (aceita `append`/`replace` do back). Desconhecido → undefined. */
export function normalizeIdentityMode(raw: string | undefined): HeadIdentityMode | undefined {
  if (raw === undefined) return undefined;
  const value = fold(raw);
  if ((HEAD_IDENTITY_MODES as readonly string[]).includes(value)) return value as HeadIdentityMode;
  if (value === "append") return "acrescentar";
  if (value === "replace") return "substituir";
  return undefined;
}

/** Nome do back (`mission`…) → nome do kit (`missao`…); desconhecido → null. */
export function identityFieldFromApi(raw: unknown): HeadIdentityField | null {
  return typeof raw === "string" ? (normalizeIdentityField(raw) ?? null) : null;
}

/** Modo do back (`append`/`replace`) → nome do kit; desconhecido → null. */
export function identityModeFromApi(raw: unknown): HeadIdentityMode | null {
  return typeof raw === "string" ? (normalizeIdentityMode(raw) ?? null) : null;
}

/**
 * Ajuste A1 do E2E real da rodada 7 (proposta 74): missão/escopo/políticas/regras
 * em markdown com títulos ("## Você faz" / "## Você NÃO faz"). Acrescentar sem dizer
 * a seção, o texto caía no FIM, dentro da última seção (no 158, a de proibições): o
 * pedido de PERMISSÃO virava PROIBIÇÃO. Agora `--section "<título>"` diz onde o texto
 * entra; o back recusa com 422 SECTION_REQUIRED quando o texto tem títulos e a seção
 * não veio, e SECTION_NOT_FOUND quando ela não existe (as duas com a lista de títulos).
 *
 * Título como está no texto, sem os `#` (o kit tira `#` do começo se o agente mandar
 * "## Você faz"). O back compara sem acento, caixa, ênfase, dois pontos e espaços extras.
 */
export function normalizeIdentitySection(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return raw
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

/**
 * Seção de proibições pelo TÍTULO ("Você NÃO faz", "Nunca", "Proibições",
 * "Restrições", "Fora do escopo", "Limites"). Espelha `sectionPolarity` do back (identitySections.ts), só a parte
 * de proibição: o kit usa para avisar no `--dry-run`, antes de abrir a proposta.
 */
const PROHIBITIVE_TITLE_RE =
  /(?<![\p{L}])(nao|nunca|jamais|proibid[oa]s?|proibir|proibic(?:ao|oes)|vedad[oa]s?|evite|evitar|restric(?:ao|oes))(?![\p{L}])/u;
/** "Fora do escopo", "Limites", "Vetado" (review back-10 da rodada 7; espelha o back). */
const PROHIBITIVE_TITLE_EXTRA_RE =
  /(?<![\p{L}])(fora d[oe]s?(?: (?:seu|sua|meu|minha|nosso|nossa))? escopos?|limites?|vetad[oa]s?|vetar)(?![\p{L}])/u;

export function isProhibitionSection(title: string | undefined): boolean {
  if (!title) return false;
  const t = fold(title);
  return PROHIBITIVE_TITLE_RE.test(t) || PROHIBITIVE_TITLE_EXTRA_RE.test(t);
}

export const HEAD_PROPOSAL_LIMITS = {
  nameMaxChars: 160,
  descriptionMaxChars: 160,
  reasonMaxChars: 2_000,
  modeloMaxBytes: 30 * 1024,
  playbookMaxBytes: 30 * 1024,
  learningEntryMaxBytes: 4 * 1024,
  /** Identidade: teto por coluna (TEXT, 64 KB). O back confere o texto DEPOIS da mudança. */
  identityMaxBytes: 65_535,
  /** Nome da seção (`--section`): título de markdown, não texto livre (mesmo teto do back). */
  identitySectionMaxChars: 200
} as const;

/** step_ref aceito em playbook (os que o runner e o chat usam). */
export const PLAYBOOK_STEP_REF_RE = /^(automation|chat|flow\d+:\d+)$/;

/** Id de doc da cabeça (mesmo formato que o back aceita em `/agent/:id/head/doc/:docId`). */
export const HEAD_DOC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function byteLength(text: string): number {
  return Buffer.byteLength(text ?? "", "utf8");
}

/**
 * Corpo do `POST /agent-head-proposal`. Agente, run e empresa saem do TOKEN no
 * back (nunca do corpo). Validação cruzada (nome/descrição do modelo, step_ref do
 * playbook, tamanho por tipo) no `superRefine`, com a regra escrita como a flag.
 */
export const proposeHeadChangeInputSchema = z
  .object({
    kind: z.enum(HEAD_PROPOSAL_KINDS),
    name: z.string().optional(),
    description: z.string().optional(),
    content: z.string(),
    stepRef: z.string().optional(),
    reason: z.string(),
    sourceArtifactId: z.number().int().positive().optional(),
    /** Só em `identidade`: missao|escopo|politicas|regras (aceita com acento e o nome do back). */
    field: z.string().optional(),
    /** Só em `identidade`: acrescentar (padrão) ou substituir. */
    mode: z.string().optional(),
    /** Só em `identidade` com acrescentar: título da seção onde o texto entra (A1 do E2E). */
    section: z.string().optional(),
    /**
     * Rodada 8 (D5), qualquer tipo: o que o agente faz depois da aprovação (`--then`).
     * Sem ele, aprovar só avisa na conversa (a cabeça não continua sozinha).
     */
    then: z.string().optional()
  })
  .superRefine((value, ctx) => {
    const L = HEAD_PROPOSAL_LIMITS;
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: "custom", path: [path], message });
    };
    const name = (value.name ?? "").trim();
    const description = (value.description ?? "").trim();
    const reason = value.reason.trim();
    if (!reason) issue("reason", "--reason é obrigatório: diga por que e quem pediu");
    else if (reason.length > L.reasonMaxChars) issue("reason", `--reason aceita no máximo ${L.reasonMaxChars} caracteres`);
    if (name.length > L.nameMaxChars) issue("name", `--name aceita no máximo ${L.nameMaxChars} caracteres`);
    if (description.length > L.descriptionMaxChars) {
      issue("description", `--description aceita no máximo ${L.descriptionMaxChars} caracteres`);
    }
    if (!value.content.trim()) issue("content", "o arquivo do --file está vazio");
    const bytes = byteLength(value.content);
    if (value.kind === "modelo") {
      if (!name) issue("name", "--name é obrigatório no modelo (o nome que aparece no índice da cabeça)");
      if (!description) issue("description", "--description é obrigatório no modelo (uma frase dizendo quando usar)");
      if (bytes > L.modeloMaxBytes) {
        issue("content", `o modelo passa de ${L.modeloMaxBytes / 1024} KB (${Math.ceil(bytes / 1024)} KB): guarde só o CSS e o esqueleto com marcadores {{...}}`);
      }
    } else if (value.kind === "aprendizado") {
      if (bytes > L.learningEntryMaxBytes) {
        issue("content", `um aprendizado tem no máximo ${L.learningEntryMaxBytes / 1024} KB (${Math.ceil(bytes / 1024)} KB): resuma em poucas linhas`);
      }
    } else if (value.kind === "identidade") {
      if (value.field === undefined || !value.field.trim()) {
        issue("field", "--field é obrigatório na identidade: missao, escopo, politicas ou regras");
      } else if (!normalizeIdentityField(value.field)) {
        issue("field", `--field precisa ser missao, escopo, politicas ou regras (recebido: ${value.field.trim().slice(0, 40)})`);
      }
      if (value.mode !== undefined && !normalizeIdentityMode(value.mode)) {
        issue("mode", `--mode precisa ser acrescentar ou substituir (recebido: ${value.mode.trim().slice(0, 40)})`);
      }
      if (value.section !== undefined) {
        const section = normalizeIdentitySection(value.section) ?? "";
        if (!section) {
          issue("section", "--section precisa do título da seção, como está no texto (ex.: --section \"Você faz\")");
        } else if (section.length > L.identitySectionMaxChars) {
          issue("section", `--section é o título da seção (até ${L.identitySectionMaxChars} caracteres), não o texto`);
        }
        if (normalizeIdentityMode(value.mode) === "substituir") {
          issue(
            "section",
            "--section só vale com --mode acrescentar; para substituir, o --file traz o texto completo novo, sem --section"
          );
        }
      }
      if (bytes > L.identityMaxBytes) {
        issue(
          "content",
          `o texto passa de 64 KB (${bytes} bytes, teto ${L.identityMaxBytes}), o teto de cada campo da identidade`
        );
      }
      // O corpo da identidade não leva nome, descrição nem etapa: aceitar calado faria o
      // dry-run ecoar algo que o POST descarta (simétrico ao --field/--mode fora daqui).
      const extras = [
        value.name !== undefined ? "--name" : null,
        value.description !== undefined ? "--description" : null,
        value.stepRef !== undefined ? "--step-ref" : null
      ].filter((flag): flag is string => flag !== null);
      if (extras.length > 0) {
        issue(
          value.name !== undefined ? "name" : value.description !== undefined ? "description" : "stepRef",
          `--name, --description e --step-ref não valem para --kind identidade (recebido: ${extras.join(", ")}); ` +
            "o campo vai em --field, a seção (título) em --section e o texto em --file"
        );
      }
    } else {
      const stepRef = (value.stepRef ?? "").trim();
      if (!PLAYBOOK_STEP_REF_RE.test(stepRef)) {
        issue("stepRef", "--step-ref é obrigatório no playbook: automation, chat ou flow<id>:<etapa>");
      }
      if (bytes > L.playbookMaxBytes) {
        issue("content", `o playbook passa de ${L.playbookMaxBytes / 1024} KB (${Math.ceil(bytes / 1024)} KB)`);
      }
    }
    if (value.sourceArtifactId !== undefined && value.kind !== "modelo") {
      issue("sourceArtifactId", "--from-artifact só vale para --kind modelo");
    }
    if (value.kind !== "identidade" && (value.field !== undefined || value.mode !== undefined)) {
      issue(value.field !== undefined ? "field" : "mode", "--field e --mode só valem para --kind identidade");
    }
    if (value.kind !== "identidade" && value.section !== undefined) {
      issue("section", "--section só vale para --kind identidade");
    }
    const thenIssue = nextTaskIssue(value.then);
    if (thenIssue) issue("then", thenIssue);
  });

export type ProposeHeadChangeInput = z.input<typeof proposeHeadChangeInputSchema>;

export const getAgentHeadParamsSchema = z.object({
  agentId: z.number().int().positive(),
  stepRef: z.string().trim().min(1).max(80)
});

export const getAgentHeadDocParamsSchema = z.object({
  agentId: z.number().int().positive(),
  docId: z.string().regex(HEAD_DOC_ID_RE, "id do doc inválido (letras, números, _ e -, até 64)")
});
