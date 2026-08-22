import { readFile } from "node:fs/promises";
import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { envCardId } from "../env-defaults.js";

interface ArtifactPublishOptions {
  cardId?: string;
  card?: string;
  type: string;
  title: string;
  file: string;
  accent?: string;
  density?: string;
  variant?: string;
  full?: boolean;
}

export function registerArtifactPublishCommand(artifactCommand: Command): void {
  const command = artifactCommand
    .command("publish")
    .description("MUTAÇÃO: publica/atualiza um artefato HTML num card (nova versão, mesma URL)")
    // `--card-id` é a flag canônica; `--card` é alias tolerado (LLMs erram pra
    // ele com frequência — caso real do run 96; aceitar é mais barato que o retry).
    .option("--card-id <id>", "ID do card")
    .option("--card <id>", "Alias de --card-id")
    .requiredOption("--type <type>", "Tipo do artefato (ex.: mapa-cotacao, one-pager)")
    .requiredOption("--title <title>", "Título do artefato")
    .requiredOption("--file <path>", "Caminho do arquivo HTML (fragmento semântico)")
    .option("--accent <accent>", "Cor de destaque: orange|purple|red|blue|green|teal|slate|amber|rose|indigo")
    .option("--density <density>", "Densidade: default|compact")
    .option("--variant <variant>", "Variante de tema: editorial (documento formal)")
    .option("--full", "Devolve o envelope completo. Default: {artifactId, slug, version}")
    .action(
      createCommandAction(async ({ kit }, options: ArtifactPublishOptions) => {
        const rawCardId = options.cardId ?? options.card ?? envCardId();
        const cardId = Number(rawCardId);
        if (!rawCardId || !Number.isInteger(cardId) || cardId <= 0) {
          throw new CangeValidationError(
            "--card-id deve ser um inteiro positivo (aceita --card como alias; em automação, RUNNER_CARD_ID do ambiente é usado como default)."
          );
        }

        let html: string;
        try {
          html = await readFile(options.file, "utf8");
        } catch (error) {
          throw new CangeValidationError(
            `Não foi possível ler o arquivo HTML em ${options.file}: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        const result = await kit.contracts.publishArtifact({
          cardId,
          type: options.type,
          title: options.title,
          html,
          ...(options.accent ? { accent: options.accent } : {}),
          ...(options.density ? { density: options.density } : {}),
          ...(options.variant ? { variant: options.variant } : {}),
        });

        if (options.full) {
          return result;
        }
        // Saída ENXUTA (o back já devolve enxuto; passamos o essencial adiante).
        const r = (result.raw ?? {}) as Record<string, unknown>;
        return {
          artifactId: r.id_artifact,
          slug: r.slug,
          version: r.version,
          visibility: r.visibility,
          // Id do ANEXO cunhado: grave-o num campo de anexo (INPUT_ATTACH_FIELD)
          // via `card update-values` para o artefato aparecer NAQUELE campo.
          attachmentId: r.attachment_id,
          ...(Array.isArray(r.warnings) && r.warnings.length > 0 ? { warnings: r.warnings } : {})
        };
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope: "{ artifactId, slug, version, visibility, attachmentId, warnings? } — com --full: { raw }",
    fieldsLocation:
      "O --file é o FRAGMENTO HTML semântico (h1-h4, p, table, ul, classes do tema). O produto injeta o tema oficial; NÃO escreva CSS nem <html>/<head>. Terminar com <!-- /artifact -->. Para pôr o artefato num CAMPO de anexo do card, grave o `attachmentId` no valor do campo (INPUT_ATTACH_FIELD) via `card update-values`.",
    example: 'artifact publish --card-id 1226170 --type mapa-cotacao --title "Mapa — Pedido 123" --file /tmp/mapa.html'
  });
}
