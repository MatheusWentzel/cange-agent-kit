import type { Command } from "commander";

import { extractArray } from "../../contracts/raw-adapters.js";
import { dropEmpty } from "../../utils/lean.js";
import { createCommandAction } from "../context.js";
import { addSearchSynonyms } from "../helpers.js";

/** Um fluxo na saída enxuta (rodada 5): o que o agente usa para escolher e paginar. */
export interface LeanFlow {
  id?: number | string;
  title?: string;
  formInitId?: number | string;
  /** Cartões ativos (não arquivados) do fluxo: decide paginação e filtro. */
  totalCards?: number;
  /** Tipo de acesso do usuário no fluxo (`typeUserAccess`: A, M, V...). */
  access?: string;
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

interface MyFlowsOptions {
  name?: string;
}

export function registerMyFlowsCommand(program: Command): void {
  const command = program
    .command("my-flows")
    .description(
      "Lista os flows disponíveis para o usuário autenticado (enxuto: [{id, title, formInitId, totalCards, access}]; --full traz o raw)"
    )
    .option("--name <texto>", "Filtra pelo nome do fluxo (--q e --search são sinônimos)")
    .action(
      createCommandAction(async ({ kit, profile }, options: MyFlowsOptions) => {
        const result = await kit.contracts.getMyFlows();
        // P7: filtro por nome, como no my-registers (o índice casa com o `raw`).
        const search = options.name?.trim().toLowerCase();
        const keep = result.summaries.map((summary) =>
          search ? (summary.title ?? "").toLowerCase().includes(search) : true
        );
        if (profile === "full") {
          const summaries = result.summaries.filter((_summary, index) => keep[index]);
          return {
            raw: result.raw,
            summaries,
            total: summaries.length
          };
        }
        // Rodada 5: o `raw` era 98,6% do texto (schema_view escapado, hash, cor,
        // ícone, datas) e, acima de 30 KB, o agente só via o preview do raw e nunca
        // os summaries. Enxuto: só o que decide qual fluxo usar.
        const rawItems = extractArray(result.raw);
        const summaries: LeanFlow[] = result.summaries
          .map((summary, index) => {
            const raw = (rawItems[index] ?? {}) as Record<string, unknown>;
            return {
              id: summary.id,
              title: summary.title,
              formInitId: summary.formInitId,
              totalCards: numberOrUndefined(raw.total_cards ?? raw.flow_total_cards),
              access: typeof raw.typeUserAccess === "string" ? raw.typeUserAccess : undefined
            };
          })
          .filter((_summary, index) => keep[index]);
        return dropEmpty({ summaries, total: summaries.length });
      })
    );
  addSearchSynonyms(command, "name", ["q", "search"]);
}
