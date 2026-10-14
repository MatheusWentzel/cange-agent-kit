import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../client/errors.js";
import { updateRegisterPayloadSchema } from "../../schemas/registers.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction, withExitCode } from "../context.js";
import { EXIT_CODES } from "../exit-codes.js";
import { readPayloadFile } from "../helpers.js";
import {
  addInlineValueOptions,
  authOnce,
  fieldTitles,
  formattedInfo,
  formattedOf,
  parseInlineValues,
  resolveRegisterValues,
  throwIfInvalid,
  validationSummary,
  type InlineValueOptions
} from "../write-support.js";

interface RegisterUpdateOptions extends InlineValueOptions {
  payload?: string;
  validateFields?: boolean;
  dryRun?: boolean;
  registerId?: string;
  formAnswerId?: string;
}

export function registerRegisterUpdateCommand(registerCommand: Command): void {
  const command = registerCommand
    .command("update")
    .description(
      "MUTAÇÃO: atualiza entrada de cadastro (1 passo: --register-id + --form-answer-id + --set; campo pelo título, id ou hash)"
    )
    .option("--register-id <id>", "Cadastro (número, link ou hash)")
    .option("--form-answer-id <id>", "Entrada do cadastro (o `id` em `register entries`)")
    .option("--payload <path>", "AVANÇADO: arquivo JSON {idForm, registerId, formAnswerId, values}");
  addInlineValueOptions(command);
  command
    .option("--validate-fields", "Valida values contra fields antes de mutar; o --payload é sempre convertido pelos campos, com ou sem a flag")
    .option("--dry-run", "Exibe o payload resolvido e a validação sem executar a mutação")
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: RegisterUpdateOptions) => {
        const inline = parseInlineValues(options);
        const auth = authOnce(kit, ensureAuth);

        if (!options.payload) {
          if (!options.registerId || !options.formAnswerId || !inline) {
            throw new CangeCliUsageError(
              'Informe cadastro, entrada e campos: `cange register update --register-id <id> --form-answer-id <id> --set "Campo=valor"` (ou --payload).'
            );
          }
          if (!/^\d+$/.test(options.formAnswerId)) {
            throw new CangeCliUsageError(`--form-answer-id precisa ser o id numérico da entrada (recebido: ${options.formAnswerId}).`);
          }
          const { formId, values, issues, resolved } = await resolveRegisterValues({
            kit,
            auth,
            registerId: options.registerId,
            layers: [inline],
            validate: true,
            requireRequired: false,
            passthroughUnknown: false
          });
          const payload = {
            idForm: Number(formId),
            registerId: Number(options.registerId),
            formAnswerId: Number(options.formAnswerId),
            values
          };
          // v9 (h): telefone e documento já vão no payload como a tela grava.
          const formatted = formattedInfo(formattedOf(resolved));
          if (options.dryRun) {
            const validation = validationSummary(issues);
            return withExitCode(
              { ...createDryRunResult(payload), validation, ...formatted },
              validation.valid ? EXIT_CODES.SUCCESS : EXIT_CODES.USAGE
            );
          }
          throwIfInvalid(issues);
          await kit.contracts.updateRegister(payload);
          return {
            ok: true,
            registerId: payload.registerId,
            entryId: payload.formAnswerId,
            ...formatted,
            summary: `Entrada ${payload.formAnswerId} do cadastro ${payload.registerId}: gravou ${fieldTitles(resolved)}.`
          };
        }

        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = updateRegisterPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para register update.", {
            details: parsed.error.format()
          });
        }
        const payload = parsed.data;
        const validate = options.validateFields === true;
        // K-01: o payload é convertido SEMPRE (com ou sem --validate-fields): o gate confere com
        // `--dry-run --validate-fields` e a execução real vem sem a flag, e os `values` gravados
        // têm de ser os que a aprovação mostrou. A flag só acrescenta a validação. Converter
        // exige os campos do cadastro: sem o cadastro, nada é gravado.
        const registerId =
          options.registerId ?? (payload.registerId !== undefined ? String(payload.registerId) : undefined);
        if (!registerId) {
          throw new CangeCliUsageError(
            "Informe --register-id ou registerId no payload: o kit converte os valores pelos campos do cadastro " +
              "(cange register update --payload <arquivo> --register-id <id>)."
          );
        }
        const { values, issues, resolved } = await resolveRegisterValues({
          kit,
          auth,
          registerId,
          formId: payload.idForm,
          layers: [payload.values, inline],
          validate,
          requireRequired: validate,
          passthroughUnknown: !validate
        });
        // v9 (h): telefone e documento já vão no payload como a tela grava.
        const formatted = formattedInfo(formattedOf(resolved));
        if (options.dryRun) {
          const validation = validationSummary(issues);
          return withExitCode(
            { ...createDryRunResult({ ...payload, values }), validation, ...formatted },
            validation.valid ? EXIT_CODES.SUCCESS : EXIT_CODES.USAGE
          );
        }
        throwIfInvalid(issues);
        payload.values = values;

        return { ...(await kit.contracts.updateRegister(payload)), ...formatted };
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope: "{ ok, registerId, entryId, summary } (modo --set). Com --payload: resposta da API",
    fieldsLocation: "Campo pelo título, id ou hash; a entrada é o `id` de `register entries`",
    example: 'register update --register-id 175 --form-answer-id 8812 --set "Status=Ativo"'
  });
}
