import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface ArtifactListOptions {
  cardId: string;
}

export function registerArtifactListCommand(artifactCommand: Command): void {
  const command = artifactCommand
    .command("list")
    .description("LEITURA: lista os artefatos de um card")
    .requiredOption("--card-id <id>", "ID do card")
    .action(
      createCommandAction(async ({ kit }, options: ArtifactListOptions) => {
        const cardId = Number(options.cardId);
        if (!Number.isInteger(cardId) || cardId <= 0) {
          throw new CangeValidationError("--card-id deve ser um inteiro positivo.");
        }

        const { artifacts, total } = await kit.contracts.getArtifactsByCard({ cardId });
        return { cardId, total, artifacts };
      })
    );

  annotateCommand(command, {
    envelope: "{ cardId, total, artifacts: [{ id, slug, type, title, visibility, version, ... }] }",
    fieldsLocation: "1 artefato por (card, type); version = versão vigente.",
    example: "artifact list --card-id 1226170"
  });
}
