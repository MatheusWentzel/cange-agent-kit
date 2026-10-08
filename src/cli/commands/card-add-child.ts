import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { addChildCardPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { createCommandAction } from "../context.js";
import { normalizeNumericValueKeys, readPayloadFile } from "../helpers.js";
import {
  addInlineValueOptions,
  authOnce,
  createWriteLookups,
  fieldsForMask,
  formattedInfo,
  formattedOf,
  maskPassthroughValues,
  mayNeedScreenMask,
  mergedValues,
  needsFieldResolution,
  parseInlineValues,
  resolveLayers,
  scopesFromFields,
  throwIfInvalid,
  type InlineValueOptions
} from "../write-support.js";

interface CardAddChildOptions extends InlineValueOptions {
  payload: string;
  dryRun?: boolean;
}

export function registerCardAddChildCommand(cardCommand: Command): void {
  const command = cardCommand
    .command("add-child")
    .description(
      "MUTAÇÃO: cria um card filho em outro fluxo e o vincula ao campo 'Meus Fluxos' do pai. O campo é multi-valor e REPLACE — passe parent.existingChildIds para não apagar vínculos existentes (read-modify-write)."
    )
    .requiredOption("--payload <path>", "Caminho do JSON de payload (child + parent)")
    .option("--dry-run", "Exibe o payload normalizado sem executar a mutação");
  addInlineValueOptions(command, "campos do card FILHO; vencem o child.values do arquivo");
  command.action(
      createCommandAction(async ({ kit, ensureAuth }, options: CardAddChildOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = addChildCardPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para card add-child.", {
            details: parsed.error.format()
          });
        }

        // R5-KR-03: o `map` e o `card read` enxutos mostram o id numérico do campo,
        // sem o hash. O add-child cria o filho e só DEPOIS vincula, sem transação:
        // um linkField numérico só falhava no PUT e deixava o filho órfão. Traduz
        // id → hash ANTES do POST (values pelo fluxo filho, linkField pelo fluxo
        // pai); id que não existe falha aqui, antes de criar qualquer coisa.
        const { child, parent } = parsed.data;
        // P4: chaves e valores do filho pelo resolvedor único (título, id, rótulo,
        // número em texto, data), contra o formulário do filho (child.idForm).
        const inline = parseInlineValues(options);
        // v9 (h): telefone e documento do filho vão como a tela grava.
        let formatted: ReturnType<typeof formattedInfo> = {};
        if (needsFieldResolution({ ...child.values, ...(inline ?? {}) }, inline !== undefined)) {
          const auth = authOnce(kit, ensureAuth);
          await auth();
          const { fields } = await kit.contracts.getFieldsByFlow({ flowId: child.flowId });
          const { target, others } = scopesFromFields(fields, child.idForm);
          const { resolved, issues, passthrough } = await resolveLayers({
            layers: [child.values, inline],
            forms: [{ ...target, label: "formulário do card filho" }],
            outOfScope: others,
            lookups: createWriteLookups(kit, auth),
            passthroughUnknown: true
          });
          throwIfInvalid(issues);
          child.values = mergedValues({ resolved, passthrough });
          formatted = formattedInfo(formattedOf(resolved));
        } else if (mayNeedScreenMask(child.values)) {
          await authOnce(kit, ensureAuth)();
          const fields = await fieldsForMask(async () => (await kit.contracts.getFieldsByFlow({ flowId: child.flowId })).fields);
          if (fields) {
            const masked = maskPassthroughValues(child.values, fields);
            throwIfInvalid(masked.issues);
            child.values = masked.values;
            formatted = formattedInfo(masked.formatted);
          }
        }
        if (/^\d+$/.test(parent.linkField)) {
          const link = await normalizeNumericValueKeys(kit, parent.flowId, { [parent.linkField]: true }, ensureAuth);
          parent.linkField = Object.keys(link.values)[0] ?? parent.linkField;
        }

        if (options.dryRun) {
          return {
            ...createDryRunResult({
              ...parsed.data,
              preview: {
                willCreateChildInFlow: child.flowId,
                willLinkOnParentField: parent.linkField,
                resultingChildIds: "[...existingChildIds, novoId] (REPLACE do campo multi-valor)"
              }
            }),
            ...formatted
          };
        }

        return { ...(await kit.contracts.addChildCard(parsed.data)), ...formatted };
      })
    );
}
