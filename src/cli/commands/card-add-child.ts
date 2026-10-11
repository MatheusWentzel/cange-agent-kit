import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import { addChildCardPayloadSchema } from "../../schemas/cards.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { truncatedValueIssues } from "../../utils/valueResolver.js";
import { createCommandAction } from "../context.js";
import { normalizeNumericValueKeys, readPayloadFile } from "../helpers.js";
import {
  addInlineValueOptions,
  authOnce,
  createWriteLookups,
  fieldsForMask,
  formattedInfo,
  formattedOf,
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
        let maskWarning: string | undefined;
        const merged = { ...child.values, ...(inline ?? {}) };
        if (Object.keys(merged).length > 0) {
          // N-3 (2ª rodada do Alex): o payload é convertido SEMPRE, como nos outros 5 comandos
          // (K-01): o rótulo de opção, a data dd/mm/aaaa e o nome de usuário num payload só de hash
          // iam crus para o back. Custo: 1 GET dos campos do fluxo filho.
          const auth = authOnce(kit, ensureAuth);
          await auth();
          const load = async () => (await kit.contracts.getFieldsByFlow({ flowId: child.flowId })).fields;
          // Chave de título/id (ou inline) só se resolve com os campos: a falha de leitura sobe como
          // antes. Só hash: K-09 (execução real falha fechado; dry-run segue sem converter, com aviso).
          const loaded = needsFieldResolution(merged, inline !== undefined)
            ? { fields: await load() }
            : await fieldsForMask(load, { dryRun: options.dryRun === true });
          maskWarning = loaded.warning;
          if (loaded.fields) {
            const { target, others } = scopesFromFields(loaded.fields, child.idForm);
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
          } else {
            // K-04: sem os campos também não grava o texto cortado da leitura enxuta.
            throwIfInvalid(truncatedValueIssues(child.values));
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
            ...formatted,
            ...(maskWarning ? { warning: maskWarning } : {})
          };
        }

        return { ...(await kit.contracts.addChildCard(parsed.data)), ...formatted };
      })
    );
}
