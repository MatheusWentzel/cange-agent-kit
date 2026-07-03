import type { Command } from "commander";

import { annotateCommand, buildManifest } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

/**
 * Registra `cange manifest` — a fonte de verdade legível em runtime.
 * Fecha sobre `program` para percorrer a árvore de comandos completa.
 */
export function registerManifestCommand(program: Command): void {
  const manifestCommand = program
    .command("manifest")
    .description(
      "Fonte de verdade: lista TODOS os comandos, flags, envelope de saída e exemplos (gerado do registry de comandos)"
    )
    .action(
      createCommandAction(async () => buildManifest(program), { requiresAuth: false })
    );

  annotateCommand(manifestCommand, {
    envelope: "{ cli, version, envelopeConvention, discovery, globalOptions[], commands[] }",
    fieldsLocation:
      "commands[] é recursivo (subcommands[]); cada comando traz path (pronto p/ invocar), options[], envelope e example",
    example: "cange manifest --output json"
  });
}
