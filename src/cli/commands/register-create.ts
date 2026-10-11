import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../client/errors.js";
import { createRegisterPayloadSchema } from "../../schemas/registers.js";
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

interface RegisterCreateOptions extends InlineValueOptions {
  payload?: string;
  validateFields?: boolean;
  dryRun?: boolean;
  registerId?: string;
}

export function registerRegisterCreateCommand(registerCommand: Command): void {
  const command = registerCommand
    .command("create")
    .description("MUTAÇÃO: cria entrada de cadastro (1 passo: --register-id + --set; campo pelo título, id ou hash)")
    .option("--register-id <id>", "Cadastro (número, link ou hash)")
    .option("--payload <path>", "AVANÇADO: arquivo JSON {idForm, registerId, origin, values}");
  addInlineValueOptions(command);
  command
    .option("--validate-fields", "Valida values contra fields antes de mutar (inclui obrigatórios); o --payload é sempre convertido pelos campos, com ou sem a flag")
    .option("--dry-run", "Exibe o payload resolvido e a validação sem executar a mutação")
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: RegisterCreateOptions) => {
        const inline = parseInlineValues(options);
        const auth = authOnce(kit, ensureAuth);

        if (!options.payload) {
          if (!options.registerId) {
            throw new CangeCliUsageError(
              'Informe o cadastro: `cange register create --register-id <id> --set "Campo=valor"` (ou --payload).'
            );
          }
          const { formId, values, issues, resolved } = await resolveRegisterValues({
            kit,
            auth,
            registerId: options.registerId,
            layers: [inline],
            validate: true,
            requireRequired: options.validateFields === true || options.dryRun === true,
            passthroughUnknown: false
          });
          const payload = {
            idForm: Number(formId),
            registerId: Number(options.registerId),
            origin: "/cange-agent-kit",
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
          const result = await kit.contracts.createRegister(payload);
          const raw = (result.raw ?? {}) as Record<string, unknown>;
          const entryId = raw.id_form_answer ?? raw.id;
          return {
            ok: true,
            registerId: payload.registerId,
            ...(entryId !== undefined ? { entryId } : {}),
            ...formatted,
            summary: `Entrada criada no cadastro ${options.registerId}; gravou ${fieldTitles(resolved)}.`
          };
        }

        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        assertNoLegacyRegisterContext(payloadRaw);
        const parsed = createRegisterPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para register create.", {
            details: parsed.error.format()
          });
        }
        const payload = parsed.data;
        const registerId = options.registerId ?? String(payload.registerId);
        const validate = options.validateFields === true;
        // K-01: o payload é convertido SEMPRE (com ou sem --validate-fields): o gate confere com
        // `--dry-run --validate-fields` e a execução real vem sem a flag, e os `values` gravados
        // têm de ser os que a aprovação mostrou. A flag só acrescenta a validação.
        // R5-KR-03 + P4: chave pelo título, id ou hash; valores convertidos para o tipo do campo.
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

        return { ...(await kit.contracts.createRegister(payload)), ...formatted };
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope: "{ ok, registerId, entryId?, summary } (modo --set). Com --payload: resposta da API",
    fieldsLocation: "Campo pelo título, id ou hash; valor convertido para o tipo do campo (número, data, opção, usuário, cadastro)",
    example: 'register create --register-id 175 --set "Fornecedor=ACME LTDA" --set "CNPJ=12.345.678/0001-90"'
  });
}

/**
 * O payload antigo levava o id do cadastro aninhado em `registerContext`, que o
 * backend nunca leu: toda criação morria em 404 "não foi possível encontrar a
 * referência do formulário". Quem ainda tiver payload no formato velho recebe a
 * instrução de migração em vez do erro genérico de schema.
 */
function assertNoLegacyRegisterContext(payloadRaw: unknown): void {
  if (
    typeof payloadRaw !== "object" ||
    payloadRaw === null ||
    !("registerContext" in payloadRaw) ||
    "registerId" in payloadRaw
  ) {
    return;
  }

  const legacy = (payloadRaw as { registerContext?: unknown }).registerContext;
  const hint = extractLegacyRegisterId(legacy);
  throw new CangeCliUsageError(
    "Payload no formato antigo: `registerContext` foi removido porque o backend nunca o leu " +
      "(POST /form/new-answer espera `register_id` no nível raiz). " +
      `Troque por "registerId": ${hint ?? "<id do cadastro>"} no nível raiz do payload.`
  );
}

function extractLegacyRegisterId(registerContext: unknown): string | undefined {
  if (typeof registerContext !== "object" || registerContext === null) {
    return undefined;
  }
  const context = registerContext as Record<string, unknown>;
  const candidates = [context.registerId, context.idRegister, context.register_id];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}
