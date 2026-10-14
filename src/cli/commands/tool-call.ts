import type { Command } from "commander";

import { CangeToolCallError, CangeValidationError, type CangeToolRef } from "../../client/errors.js";
import { annotateCommand } from "../command-metadata.js";
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
 * Sucesso: a resposta do invoke em stdout, exit 0 ({ success, statusCode, data, executionTime, ... }).
 * v9 (conversa 859): `success:false` (o serviço externo recusou ou não respondeu)
 * vira `CangeToolCallError` com exit 6, a mensagem diz o nome, o status e o host.
 * Erro HTTP do próprio Cange no invoke (403, 404, 422) continua exit 4.
 */
export function registerToolCallCommand(toolCommand: Command): void {
  const command = toolCommand
    .command("call <toolId>")
    .description("MUTAÇÃO: dispara uma ferramenta de API do agente passando só os parâmetros")
    .option("--params <path>", "Caminho de um JSON com os parâmetros { nome: valor }")
    .option("--params-json <json>", "JSON inline dos parâmetros (alternativa ao --params)")
    .action(
      createCommandAction(async ({ kit }, toolId: string, options: ToolCallOptions) => {
        const id = Number(String(toolId).replace(/^#/, ""));
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

        const response = await kit.client.post<unknown>(`/agent-tool/api/${id}/invoke`, { body: { params } });
        if (isRecord(response) && response.success === false) {
          throw toolCallErrorFrom(id, response);
        }
        return response;
      })
    );

  annotateCommand(command, {
    envelope:
      "Sucesso (exit 0): a resposta do invoke { success: true, statusCode, data, executionTime, ... }. " +
      "Falha da ferramenta (exit 6, stderr): { name: \"CangeToolCallError\", code: \"TOOL_CALL_FAILED\", message, tool: {id, name}, status, host, durationMs, details }. " +
      "Erro do próprio Cange (sem acesso, parâmetro inválido): exit 4",
    fieldsLocation:
      "Exit 6 = o serviço externo recusou ou não respondeu: conte como falha na resposta, com o nome e o motivo. " +
      "Não busque o dado em outra fonte por conta própria; só vale tentar outra ferramenta de API com a mesma finalidade, uma vez.",
    example: "tool call 12 --params-json '{\"cnpj\":\"91292987000110\"}'"
  });
}

/** Próximo passo depois da falha (sai em `hint` no JSON do erro). */
export const TOOL_FAILED_HINT =
  "Conte isso como falha na resposta. Não busque o dado em outra fonte; só vale tentar outra ferramenta de API com a mesma finalidade, uma vez.";

const TIMEOUT_CODES: ReadonlySet<string> = new Set(["ECONNABORTED", "ETIMEDOUT"]);
const STATUS_IN_TEXT_RE = /status code (\d{3})/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function httpStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function statusInText(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = STATUS_IN_TEXT_RE.exec(value);
  return match ? httpStatus(Number(match[1])) : null;
}

/**
 * C5: o back novo manda `upstream_status` (o status do serviço externo). Back
 * antigo: o status sai de `error.details.message` ("status code 503"), depois de
 * `error.message`, depois de `statusCode`, nessa ordem.
 */
function upstreamStatusOf(response: Record<string, unknown>, error: Record<string, unknown>): number | null {
  if ("upstream_status" in response) return httpStatus(response.upstream_status);
  const details = error.details;
  return (
    (isRecord(details) ? statusInText(details.message) : statusInText(details)) ??
    statusInText(error.message) ??
    httpStatus(response.statusCode)
  );
}

/** C5: `host` do back novo; senão o hostname do `resolvedUrl`. */
function hostOf(response: Record<string, unknown>): string | null {
  if (typeof response.host === "string" && response.host.trim().length > 0) return response.host.trim();
  if (typeof response.resolvedUrl === "string") {
    try {
      const hostname = new URL(response.resolvedUrl).hostname;
      return hostname.length > 0 ? hostname : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toolOf(toolId: number, response: Record<string, unknown>): CangeToolRef {
  const tool = isRecord(response.tool) ? response.tool : {};
  const name = typeof tool.name === "string" && tool.name.trim().length > 0 ? tool.name.trim() : null;
  const id = typeof tool.id === "number" && Number.isInteger(tool.id) && tool.id > 0 ? tool.id : toolId;
  return { id, name };
}

function isTimeout(error: Record<string, unknown>): boolean {
  if (typeof error.code === "string" && TIMEOUT_CODES.has(error.code)) return true;
  return typeof error.message === "string" && /\btime(d)?\s*out\b|timeout/i.test(error.message);
}

/** O motivo, em uma frase: status e host quando há; prazo; ou conexão. */
function reasonOf(status: number | null, host: string | null, error: Record<string, unknown>): string {
  if (status !== null) return host ? `o serviço respondeu ${status} em ${host}.` : `o serviço respondeu ${status}.`;
  if (isTimeout(error)) return host ? `o serviço não respondeu a tempo (${host}).` : "o serviço não respondeu a tempo.";
  return host ? `não foi possível conectar em ${host}.` : "não foi possível conectar ao serviço.";
}

/** `success:false` do `POST /agent-tool/api/:id/invoke` → erro com exit 6 (C4). */
export function toolCallErrorFrom(toolId: number, response: Record<string, unknown>): CangeToolCallError {
  const error = isRecord(response.error) ? response.error : {};
  const tool = toolOf(toolId, response);
  const status = upstreamStatusOf(response, error);
  const host = hostOf(response);
  const who = tool.name ? `A ferramenta de API "${tool.name}" (#${tool.id})` : `A ferramenta de API #${tool.id}`;
  const durationMs = typeof response.executionTime === "number" ? response.executionTime : undefined;
  return new CangeToolCallError(`${who} falhou: ${reasonOf(status, host, error)}`, {
    tool,
    status,
    host,
    ...(durationMs !== undefined ? { durationMs } : {}),
    details: response.error ?? null,
    hint: TOOL_FAILED_HINT
  });
}
