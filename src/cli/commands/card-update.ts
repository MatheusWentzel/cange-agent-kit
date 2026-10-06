import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { updateCardPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";

interface CardUpdateOptions {
  payload: string;
  dryRun?: boolean;
  /** Aceito e ignorado (P7). */
  validateFields?: boolean;
}

export function registerCardUpdateCommand(cardCommand: Command): void {
  cardCommand
    .command("update")
    .description("MUTAÇÃO: atualiza atributos principais do cartão")
    .requiredOption("--payload <path>", "Caminho do JSON de payload")
    .option("--dry-run", "Exibe payload sem executar a mutação")
    // P7 (05/10): toda outra escrita aceita --validate-fields e o agente repetia o
    // hábito aqui (erro de opção desconhecida). Aceito e ignorado: o card update não
    // grava values (título, responsável, prazo...); para values, `card update-values`.
    .option(
      "--validate-fields",
      "Aceito sem efeito: card update não grava values (para campos do formulário use `card update-values --validate-fields`)"
    )
    .action(
      createCommandAction(async ({ kit }, options: CardUpdateOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = updateCardPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          const hasValues =
            payloadRaw !== null && typeof payloadRaw === "object" && "values" in (payloadRaw as Record<string, unknown>);
          throw new CangeValidationError(
            hasValues
              ? "card update não grava values (só userId, dtDue, flowTagId, complete, archived). Para campos do formulário use `cange card update-values --payload <arquivo>`."
              : "Payload inválido para card update.",
            {
              details: parsed.error.format()
            }
          );
        }

        if (options.dryRun) {
          return createDryRunResult(parsed.data);
        }

        return kit.contracts.updateCard(parsed.data);
      })
    );
}
