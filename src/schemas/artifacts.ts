import { z } from "zod";

import { idLikeSchema } from "./common.js";

/**
 * Dono do artefato: um CARTÃO (`cardId`) ou uma CONVERSA do agente
 * (`sessionId`, agent_session). Exatamente um dos dois: o back recusa os dois
 * juntos e nenhum (422), então o kit recusa antes de chamar a API.
 */
export const publishArtifactInputSchema = z
  .object({
    cardId: z.number().int().positive().optional(),
    sessionId: z.number().int().positive().optional(),
    type: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(255),
    html: z.string().min(1),
    accent: z.string().trim().max(24).optional(),
    density: z.string().trim().max(16).optional(),
    variant: z.string().trim().max(24).optional()
  })
  .refine((value) => (value.cardId === undefined) !== (value.sessionId === undefined), {
    message: "Informe exatamente um dono do artefato: cardId (cartão) ou sessionId (conversa).",
    path: ["cardId"]
  });

export const listArtifactsByCardParamsSchema = z.object({
  cardId: idLikeSchema
});

/** Artefatos de uma CONVERSA do agente (GET /artifact/by-session). */
export const listArtifactsBySessionParamsSchema = z.object({
  sessionId: idLikeSchema
});

/**
 * Conferência do publish (POST /artifact/validate, rodada 3): só o HTML vai ao
 * back, que sanea e mede sem gravar nada.
 */
export const validateArtifactInputSchema = z.object({
  html: z.string().min(1)
});

/** Fonte de um artefato publicado (GET /artifact/:id/source), opcionalmente de uma versão. */
export const getArtifactSourceParamsSchema = z.object({
  artifactId: z.number().int().positive(),
  version: z.number().int().positive().optional()
});
