import type { Command } from "commander";

import { guidePayload } from "../../guide.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface GuideOptions {
  topic?: string;
}

/**
 * `cange guide` — bússola do agente: o CAMINHO certo de cada tarefa comum no
 * Cange via este kit (baixar anexo, ler/escrever campos, comentar, mover card),
 * mais regras de ouro e armadilhas. Conteúdo estático (não autentica).
 *
 * A mesma fonte (`guidePayload`) vai embutida no `cange manifest`; este comando é
 * a bússola direta para quando o agente se perde no meio de uma tarefa.
 */
export function registerGuideCommand(program: Command): void {
  const guideCommand = program
    .command("guide")
    .description(
      "Bússola: o caminho certo de cada tarefa comum (baixar anexo, ler/escrever campos, comentar, mover card) + regras de ouro e armadilhas"
    )
    .option("--topic <t>", "Filtra por jornada (id ou termo), ex.: anexo, escrever, comentar, mover")
    .action(
      createCommandAction(
        async (_ctx: unknown, options: GuideOptions) => {
          const g = guidePayload();
          const topic = options.topic?.trim().toLowerCase();
          if (!topic) return g;
          const jornadas = g.jornadas.filter(
            (j) =>
              j.id.includes(topic) ||
              j.quando.toLowerCase().includes(topic) ||
              j.passos.some((p) => p.toLowerCase().includes(topic))
          );
          return { ...g, jornadas: jornadas.length > 0 ? jornadas : g.jornadas };
        },
        { requiresAuth: false }
      )
    );

  annotateCommand(guideCommand, {
    envelope: "{ regrasDeOuro[], jornadas[{ id, quando, passos[], armadilha? }], armadilhas[], dica }",
    example: "cange guide --topic anexo"
  });
}
