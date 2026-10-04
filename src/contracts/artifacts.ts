import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import {
  getArtifactSourceParamsSchema,
  listArtifactsByCardParamsSchema,
  listArtifactsBySessionParamsSchema,
  publishArtifactInputSchema,
  validateArtifactInputSchema
} from "../schemas/artifacts.js";
import { toNumber } from "../schemas/common.js";

export interface ArtifactSummary {
  id: number | null;
  slug: string | null;
  type: string | null;
  title: string | null;
  visibility: string | null;
  version: number | null;
  createdByKind: string | null;
  dtLastUpdate: string | null;
}

/**
 * Dono do artefato: cartão OU conversa do agente (agent_session), nunca os
 * dois. Artefato de conversa não vira anexo de cartão (o back não cria
 * attachment) e só o dono da conversa (e o run dela) enxerga.
 */
export type ArtifactOwner =
  | { cardId: number; sessionId?: undefined }
  | { sessionId: number; cardId?: undefined };

export type PublishArtifactInput = ArtifactOwner & {
  type: string;
  title: string;
  html: string;
  accent?: string;
  density?: string;
  variant?: string;
};

/**
 * Resultado da conferência do publish (POST /artifact/validate). `ok` diz se o
 * publish passaria; `warnings` lista tudo o que o saneador removeria (CSS com
 * recurso externo, tag ou atributo proibido, link fora da regra).
 */
export interface ArtifactValidation {
  ok: boolean;
  error: string | null;
  warnings: string[];
  normalizations: string[];
  rawBytes: number | null;
  htmlBytes: number | null;
  cssBytes: number | null;
  maxCssBytes: number | null;
}

/**
 * Fonte de um artefato publicado (GET /artifact/:id/source): o fragmento
 * saneado (com o `<style data-artifact-css>` formatado) e o que o restyle
 * precisa repetir no publish (tipo, título, dono e accent/density/variant).
 */
export interface ArtifactSource {
  artifactId: number | null;
  type: string | null;
  title: string | null;
  cardId: number | null;
  flowId: number | null;
  sessionId: number | null;
  currentVersion: number | null;
  version: number | null;
  themeVersion: string | null;
  accent: string | null;
  density: string | null;
  variant: string | null;
  html: string;
  htmlBytes: number | null;
  cssBytes: number | null;
  /**
   * Rodada 5: só o CSS saneado (sem o `<style>` e sem o HTML com os dados). É o
   * que o `agent head propose --from-artifact` copia para o modelo. null = back
   * anterior à rodada 5 ou artefato sem CSS próprio.
   */
  css: string | null;
}

export interface ArtifactsContracts {
  publishArtifact: (input: PublishArtifactInput) => Promise<{ raw: unknown }>;
  getArtifactsByCard: (input: {
    cardId: number | string;
  }) => Promise<{ raw: unknown; artifacts: ArtifactSummary[]; total: number }>;
  getArtifactsBySession: (input: {
    sessionId: number | string;
  }) => Promise<{ raw: unknown; artifacts: ArtifactSummary[]; total: number }>;
  validateArtifact: (input: { html: string }) => Promise<ArtifactValidation & { raw: unknown }>;
  getArtifactSource: (input: { artifactId: number; version?: number }) => Promise<ArtifactSource & { raw: unknown }>;
}

export function createArtifactsContracts(client: CangeClient): ArtifactsContracts {
  return {
    async publishArtifact(input) {
      const parsed = publishArtifactInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para publishArtifact.", {
          details: parsed.error.format()
        });
      }

      // HTML vai como campo JSON (é texto, não binário). O sanitizador do back
      // rejeita fragmento > 2MB (o body-parser aceita 50MB, mas o teto do artefato é 2MB).
      // Dono xor: só a chave do dono informado vai no body (o back devolve 422
      // com as duas ou nenhuma).
      const owner =
        parsed.data.sessionId !== undefined
          ? { session_id: parsed.data.sessionId }
          : { card_id: parsed.data.cardId };
      const raw = await client.post<unknown>("/artifact", {
        body: {
          ...owner,
          type: parsed.data.type,
          title: parsed.data.title,
          html: parsed.data.html,
          ...(parsed.data.accent ? { accent: parsed.data.accent } : {}),
          ...(parsed.data.density ? { density: parsed.data.density } : {}),
          ...(parsed.data.variant ? { variant: parsed.data.variant } : {}),
        },
        retry: false
      });
      return { raw };
    },

    async getArtifactsByCard(input) {
      const parsed = listArtifactsByCardParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getArtifactsByCard.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/artifact/by-card", {
        query: { card_id: toNumber(parsed.data.cardId) }
      });

      const record = (raw ?? {}) as Record<string, unknown>;
      const items = Array.isArray(record.artifacts) ? (record.artifacts as unknown[]) : [];
      const artifacts = items.map((item) => summarizeArtifact(item));
      return { raw, artifacts, total: artifacts.length };
    },

    async getArtifactsBySession(input) {
      const parsed = listArtifactsBySessionParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getArtifactsBySession.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>("/artifact/by-session", {
        query: { session_id: toNumber(parsed.data.sessionId) }
      });

      const record = (raw ?? {}) as Record<string, unknown>;
      const items = Array.isArray(record.artifacts) ? (record.artifacts as unknown[]) : [];
      const artifacts = items.map((item) => summarizeArtifact(item));
      return { raw, artifacts, total: artifacts.length };
    },

    async validateArtifact(input) {
      const parsed = validateArtifactInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Payload inválido para validateArtifact.", {
          details: parsed.error.format()
        });
      }

      // Leitura no gate do agente (READ_VIA_POST no back): não grava nada, não
      // pede grant nem aprovação. Sem retry: o back tem rate limit por usuário.
      const raw = await client.post<unknown>("/artifact/validate", {
        body: { html: parsed.data.html },
        retry: false
      });
      const r = (raw ?? {}) as Record<string, unknown>;
      return {
        raw,
        ok: r.ok === true,
        error: stringOrNull(r.error),
        warnings: stringList(r.warnings),
        normalizations: stringList(r.normalizations),
        rawBytes: numberOrNull(r.raw_bytes),
        htmlBytes: numberOrNull(r.html_bytes),
        cssBytes: numberOrNull(r.css_bytes),
        maxCssBytes: numberOrNull(r.max_css_bytes)
      };
    },

    async getArtifactSource(input) {
      const parsed = getArtifactSourceParamsSchema.safeParse(input);
      if (!parsed.success) {
        throw new CangeValidationError("Parâmetros inválidos para getArtifactSource.", {
          details: parsed.error.format()
        });
      }

      const raw = await client.get<unknown>(`/artifact/${parsed.data.artifactId}/source`, {
        query: { version: parsed.data.version }
      });
      const r = (raw ?? {}) as Record<string, unknown>;
      return {
        raw,
        artifactId: numberOrNull(r.id_artifact),
        type: stringOrNull(r.type),
        title: stringOrNull(r.title),
        cardId: numberOrNull(r.card_id),
        flowId: numberOrNull(r.flow_id),
        sessionId: numberOrNull(r.session_id),
        currentVersion: numberOrNull(r.current_version),
        version: numberOrNull(r.version),
        themeVersion: stringOrNull(r.theme_version),
        accent: stringOrNull(r.accent),
        density: stringOrNull(r.density),
        variant: stringOrNull(r.variant),
        html: typeof r.html === "string" ? r.html : "",
        htmlBytes: numberOrNull(r.html_bytes),
        cssBytes: numberOrNull(r.css_bytes),
        css: typeof r.css === "string" && r.css.trim().length > 0 ? r.css : null
      };
    }
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function summarizeArtifact(raw: unknown): ArtifactSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: numberOrNull(r.id_artifact),
    slug: stringOrNull(r.slug),
    type: stringOrNull(r.type),
    title: stringOrNull(r.title),
    visibility: stringOrNull(r.visibility),
    version: numberOrNull(r.version),
    createdByKind: stringOrNull(r.created_by_kind),
    dtLastUpdate: stringOrNull(r.dt_last_update)
  };
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
