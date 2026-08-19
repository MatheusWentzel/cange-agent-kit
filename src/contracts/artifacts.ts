import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import {
  publishArtifactInputSchema,
  listArtifactsByCardParamsSchema
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

export interface ArtifactsContracts {
  publishArtifact: (input: {
    cardId: number;
    type: string;
    title: string;
    html: string;
    accent?: string;
    density?: string;
    public?: boolean;
  }) => Promise<{ raw: unknown }>;
  getArtifactsByCard: (input: {
    cardId: number | string;
  }) => Promise<{ raw: unknown; artifacts: ArtifactSummary[]; total: number }>;
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

      // HTML vai como campo JSON (é texto, não binário) — corpo até 50MB no back.
      const raw = await client.post<unknown>("/artifact", {
        body: {
          card_id: parsed.data.cardId,
          type: parsed.data.type,
          title: parsed.data.title,
          html: parsed.data.html,
          ...(parsed.data.accent ? { accent: parsed.data.accent } : {}),
          ...(parsed.data.density ? { density: parsed.data.density } : {}),
          ...(parsed.data.public ? { public: true } : {})
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
    }
  };
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
