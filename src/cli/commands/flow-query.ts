import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import type { FlowQueryEngineChoice } from "../../contracts/flowCards.js";
import { createCommandAction } from "../context.js";
import { parseOptionalBoolean } from "../helpers.js";

interface FlowQueryOptions {
  flowId: string;
  viewId?: string;
  stepId?: string;
  search?: string;
  searchScope?: string;
  archived?: string;
  engine?: string;
  pageSize?: string;
  limit?: string;
}

function parseSearchScope(value: string | undefined): "view" | "flow" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "view" || value === "flow") {
    return value;
  }
  throw new CangeCliUsageError("Valor inválido para --search-scope. Use view ou flow.");
}

function parseEngine(value: string | undefined): FlowQueryEngineChoice {
  if (value === undefined) {
    return "auto";
  }
  if (value === "auto" || value === "v1" || value === "v2") {
    return value;
  }
  throw new CangeCliUsageError("Valor inválido para --engine. Use auto, v1 ou v2.");
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CangeCliUsageError(`Valor inválido para ${flag}. Use inteiro positivo.`);
  }
  return parsed;
}

export function registerFlowQueryCommand(flowCommand: Command): void {
  flowCommand
    .command("query")
    .description(
      "Busca cartões de um flow priorizando o motor V2 (com fallback V1). Suporta view salva, busca e filtro por etapa."
    )
    .requiredOption("--flow-id <id>", "ID do flow")
    .option("--view-id <id>", "ID de uma visualização salva (aplica filtros/colunas/ordenação dela)")
    .option("--step-id <id>", "Filtra cartões por etapa atual")
    .option("--search <texto>", "Busca textual")
    .option(
      "--search-scope <scope>",
      "Escopo da busca: view (só colunas da view) | flow (todos os campos). Default: flow quando há --search sem --view-id"
    )
    .option("--archived <value>", "Filtrar arquivados (true|false)")
    .option("--engine <engine>", "Motor de query: auto (default) | v1 | v2", "auto")
    .option("--page-size <n>", "Tamanho de página do V2 (máx 500)")
    .option("--limit <n>", "Limita a quantidade total de cartões retornados")
    .action(
      createCommandAction(async ({ kit }, options: FlowQueryOptions) => {
        const explicitScope = parseSearchScope(options.searchScope);
        // Busca sem view precisa varrer todos os campos do flow, senão o back
        // busca só nas colunas da view (ausente) e não acha nada.
        const searchFieldScope =
          explicitScope ??
          (options.search && !options.viewId ? "flow" : undefined);

        return kit.contracts.fetchFlowCards({
          flowId: options.flowId,
          engine: parseEngine(options.engine),
          flowViewId: options.viewId,
          flowStepId: options.stepId,
          search: options.search,
          searchFieldScope,
          isArchived: parseOptionalBoolean(options.archived),
          pageSize: parsePositiveInt(options.pageSize, "--page-size"),
          limit: parsePositiveInt(options.limit, "--limit")
        });
      })
    );
}
