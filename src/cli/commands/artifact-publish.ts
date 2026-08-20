import { readFile } from "node:fs/promises";
import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface ArtifactPublishOptions {
  cardId: string;
  type: string;
  title: string;
  file: string;
  accent?: string;
  density?: string;
  public?: boolean;
  full?: boolean;
}

export function registerArtifactPublishCommand(artifactCommand: Command): void {
  const command = artifactCommand
    .command("publish")
    .description("MUTAÇÃO: publica/atualiza um artefato HTML num card (nova versão, mesma URL)")
    .requiredOption("--card-id <id>", "ID do card")
    .requiredOption("--type <type>", "Tipo do artefato (ex.: mapa-cotacao, one-pager)")
    .requiredOption("--title <title>", "Título do artefato")
    .requiredOption("--file <path>", "Caminho do arquivo HTML (fragmento semântico)")
    .option("--accent <accent>", "Cor de destaque: orange|purple|red|blue|green")
    .option("--density <density>", "Densidade: default|compact")
    .option("--public", "Torna o artefato público por link (default: privado)")
    .option("--full", "Devolve o envelope completo. Default: {artifactId, slug, version}")
    .action(
      createCommandAction(async ({ kit }, options: ArtifactPublishOptions) => {
        const cardId = Number(options.cardId);
        if (!Number.isInteger(cardId) || cardId <= 0) {
          throw new CangeValidationError("--card-id deve ser um inteiro positivo.");
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
          ...(options.public ? { public: true } : {})
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
          ...(Array.isArray(r.warnings) && r.warnings.length > 0 ? { warnings: r.warnings } : {})
        };
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope: "{ artifactId, slug, version, visibility, warnings? } — com --full: { raw }",
    fieldsLocation:
      "O --file é o FRAGMENTO HTML semântico (h1-h4, p, table, ul, classes do tema). O produto injeta o tema oficial no render; NÃO escreva CSS nem <html>/<head>. Terminar com <!-- /artifact --> para o back detectar truncamento.",
    example: 'artifact publish --card-id 1226170 --type mapa-cotacao --title "Mapa — Pedido 123" --file /tmp/mapa.html'
  });
}
