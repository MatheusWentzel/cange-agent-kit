import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";

interface ToolCallOptions {
  params?: string;
  paramsJson?: string;
}

/**
 * `cange tool call <toolId> --params <arquivo.json>` (ou `--params-json '<json>'`).
 *
 * Dispara uma ferramenta de API cadastrada para o agente (agent_tool type='api'). O
 * agente passa SÓ os parâmetros declarados; o template (método/URL/headers/body/auth)
 * fica travado no cadastro e é montado+disparado no back. Autorização por ownership
 * (o back confere que a tool é do próprio agente pelo token de run).
 *
 * Retorna a resposta do invoke: { success, statusCode, data, error, executionTime }.
 */
export function registerToolCallCommand(toolCommand: Command): void {
  toolCommand
    .command("call <toolId>")
    .description("MUTAÇÃO: dispara uma ferramenta de API do agente passando só os parâmetros")
    .option("--params <path>", "Caminho de um JSON com os parâmetros { nome: valor }")
    .option("--params-json <json>", "JSON inline dos parâmetros (alternativa ao --params)")
    .action(
      createCommandAction(async ({ kit }, toolId: string, options: ToolCallOptions) => {
        const id = Number(toolId);
        if (!Number.isInteger(id) || id <= 0) {
          throw new CangeValidationError("toolId inválido — informe o id numérico da ferramenta.", {
            details: { toolId }
          });
        }

        let params: unknown = {};
        if (options.params) {
          params = await readPayloadFile<unknown>(options.params);
        } else if (options.paramsJson) {
          try {
            params = JSON.parse(options.paramsJson);
          } catch {
            throw new CangeValidationError("--params-json não é um JSON válido.", {
              details: { value: options.paramsJson }
            });
          }
        }

        if (typeof params !== "object" || params === null || Array.isArray(params)) {
          throw new CangeValidationError("Os parâmetros devem ser um objeto { nome: valor }.", {
            details: { params }
          });
        }

        return kit.client.post(`/agent-tool/api/${id}/invoke`, { body: { params } });
      })
    );
}
