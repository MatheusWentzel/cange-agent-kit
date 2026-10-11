import type { Command } from "commander";

import { extractArray } from "../../contracts/raw-adapters.js";
import { CangeCliUsageError } from "../../client/errors.js";
import { dropEmpty } from "../../utils/lean.js";
import { listOutput } from "../../utils/toon.js";
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
  limit?: string;
  cursor?: string;
}

/** C4: página padrão do enxuto. Com `--name` o filtro vale para todos antes de paginar. */
export const MY_FLOWS_DEFAULT_LIMIT = 20;

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim()) || Number(value) <= 0) {
    throw new CangeCliUsageError(`${flag} deve ser um inteiro positivo.`);
  }
  return Number(value);
}

export function registerMyFlowsCommand(program: Command): void {
  const command = program
    .command("my-flows")
    .description(
      "Lista os flows disponíveis para o usuário autenticado (enxuto: [{id, title, formInitId, totalCards, access}]; --full traz o raw)"
    )
    .option("--name <texto>", "Filtra pelo nome do fluxo (--q e --search são sinônimos)")
    .option("--limit <n>", `Fluxos por página (enxuto: padrão ${MY_FLOWS_DEFAULT_LIMIT})`)
    .option("--cursor <n>", "Página seguinte: o `--cursor` que veio em `next`")
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
        // C4: página de 20 com o total e o comando da página seguinte.
        const limit = positiveInt(options.limit, "--limit") ?? MY_FLOWS_DEFAULT_LIMIT;
        if (options.cursor !== undefined && !/^\d+$/.test(options.cursor.trim())) {
          throw new CangeCliUsageError("--cursor deve ser o número que veio em `next`.");
        }
        const offset = options.cursor !== undefined ? Number(options.cursor) : 0;
        const page = summaries.slice(offset, offset + limit);
        const next =
          offset + limit < summaries.length
            ? [
                "cange my-flows",
                ...(options.name ? [`--name ${JSON.stringify(options.name)}`] : []),
                ...(options.limit ? [`--limit ${limit}`] : []),
                `--cursor ${offset + limit}`
              ].join(" ")
            : undefined;
        return listOutput(dropEmpty({ summaries: page, total: summaries.length, next }), "summaries");
      })
    );
  addSearchSynonyms(command, "name", ["q", "search"]);
}
