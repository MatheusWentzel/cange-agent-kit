import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import type { ArtifactOwner } from "../../contracts/artifacts.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

import { resolveArtifactOwner } from "./artifact-publish.js";

interface ArtifactListOptions {
  cardId?: string;
  sessionId?: string;
}

/**
 * Mesmo dono do `artifact publish`: flag explícita; sem flag, o cartão do run e,
 * sem cartão, a conversa do chat (ambiente do processo).
 */
function resolveListOwner(options: ArtifactListOptions): ArtifactOwner {
  try {
    return resolveArtifactOwner({ cardId: options.cardId, sessionId: options.sessionId });
  } catch (error) {
    if (options.cardId === undefined && options.sessionId === undefined) {
      throw new CangeValidationError(
        "Informe --card-id <id> (artefatos do cartão) ou --session-id <id> (artefatos da conversa)."
      );
    }
    throw error;
  }
}

export function registerArtifactListCommand(artifactCommand: Command): void {
  const command = artifactCommand
    .command("list")
    .description("LEITURA: lista os artefatos de um card ou de uma conversa do agente")
    .option("--card-id <id>", "ID do card")
    .option("--session-id <id>", "ID da conversa do agente (artefatos de conversa). Não combina com --card-id")
    .action(
      createCommandAction(async ({ kit }, options: ArtifactListOptions) => {
        const owner = resolveListOwner(options);

        if (owner.sessionId !== undefined) {
          const { artifacts, total } = await kit.contracts.getArtifactsBySession({ sessionId: owner.sessionId });
          return { sessionId: owner.sessionId, total, artifacts };
        }
        const { artifacts, total } = await kit.contracts.getArtifactsByCard({ cardId: owner.cardId });
        return { cardId: owner.cardId, total, artifacts };
      })
    );

  annotateCommand(command, {
    envelope:
      "{ cardId|sessionId, total, artifacts: [{ id, slug, type, title, visibility, version, ... }] }",
    fieldsLocation:
      "1 artefato por (dono, type); version = versão vigente. `id` é o que o `artifact get --id` lê. " +
      "Sem flag, usa o cartão do run e, sem cartão, a conversa do chat.",
    example: "artifact list --card-id 1226170"
  });
}
