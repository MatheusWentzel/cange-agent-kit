import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { extractFlowSteps } from "../../contracts/payload-builder.js";
import { summarizeCard } from "../../contracts/raw-adapters.js";
import type { NormalizedField } from "../../schemas/fields.js";
import { describeAllowedFileTypes, isFileAllowed } from "../../utils/attachFieldTypes.js";
import { normalizeText } from "../../utils/valueResolver.js";
import {
  allowedTypesOf,
  cardRecordOf,
  collectCardAttachments,
  currentFieldAttachmentIds,
  parseAttachmentIds,
  readFormDraft,
  resolveUsableAttachments,
  userIdFromToken
} from "../card-attachments.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { envCardId, envFlowId } from "../env-defaults.js";
import { FLOW_FROM_CARD_HINT } from "../resource-ref.js";
import { authOnce } from "../write-support.js";

interface LinkFieldOptions {
  cardId?: string;
  flowId?: string;
  field?: string;
  attachmentId?: string[];
  dryRun?: boolean;
}

function collectRepeatable(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/**
 * C2 (onda 1): `cange attachment link-field --card-id <id> --field "<campo>" --attachment-id <id>`.
 * Põe o arquivo (já subido com `attachment upload`, ou que já está no cartão) num CAMPO de
 * anexo do cartão, SOMANDO aos arquivos que o campo já tem (o `PUT /form/answer` troca a
 * lista inteira: o kit manda a lista atual mais o novo). A lista atual é a da resposta em
 * que o back grava: o rascunho da etapa (`GET /form/pre-answer`) ou a última passagem.
 *
 * É a ação "Anexos" do agente: o back trata o `PUT /form/answer` que grava campo de anexo
 * como `attachment` (permissão e aprovação de anexo, não de "Editar campos"). Por isso o
 * comando manda SÓ o campo de anexo.
 *
 * Confere antes de gravar (exit 2, nada gravado): o campo é de anexo e o cartão pode
 * gravar nele (formulário inicial, etapa atual ou etapa por onde já passou), o arquivo é
 * deste cartão ou foi você que subiu, e o tipo do arquivo é aceito pelo campo.
 * Arquivo que já está no campo não grava de novo (`noop`).
 */
export function registerAttachmentLinkFieldCommand(attachmentCommand: Command): void {
  const command = attachmentCommand
    .command("link-field")
    .description(
      "MUTAÇÃO: põe um arquivo num campo de anexo do cartão, somando aos que o campo já tem (o arquivo vem do `attachment upload` ou do próprio cartão)"
    )
    .option("--card-id <id>", "Cartão (número ou link; padrão: o cartão do run)")
    .option("--flow-id <id>", "Fluxo do cartão (opcional: vem do link, do número do cartão ou do run)")
    .requiredOption("--field <campo>", "Campo de anexo: título, id ou hash")
    .requiredOption("--attachment-id <id>", "Anexo a pôr no campo (repetível ou separado por vírgula, até 10)", collectRepeatable)
    .option("--dry-run", "Confere e mostra o que seria gravado, sem gravar")
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: LinkFieldOptions) => {
        const cardRef = options.cardId ?? envCardId();
        if (!cardRef) {
          throw new CangeCliUsageError(
            'Informe o cartão: `cange attachment link-field --card-id <id> --field "<campo>" --attachment-id <id>`.'
          );
        }
        const flowRef = options.flowId ?? envFlowId();
        if (!flowRef) throw new CangeCliUsageError(FLOW_FROM_CARD_HINT);
        const ids = parseAttachmentIds(options.attachmentId);
        if (!Array.isArray(ids)) {
          throw new CangeCliUsageError(`--attachment-id espera o número do anexo (veio "${ids.invalid}").`);
        }
        if (ids.length === 0 || ids.length > 10) {
          throw new CangeCliUsageError("Informe de 1 a 10 anexos em --attachment-id.");
        }
        const cardId = Number(cardRef);
        const flowId = Number(flowRef);

        await authOnce(kit, ensureAuth)();
        const me = userIdFromToken(kit.client.getAccessToken());
        const [found, flow] = await Promise.all([
          collectCardAttachments(kit, { flowId, cardId }),
          kit.contracts.getFlow({ idFlow: String(flowId) })
        ]);

        const field = pickAttachField(found.attachFields, options.field ?? "");
        const fieldTitle = field.title ?? field.name;
        const formId = field.formId !== undefined ? String(field.formId) : "";
        assertWritableForm({
          formId,
          fieldTitle,
          formInitId: flow.summary.formInitId !== undefined ? String(flow.summary.formInitId) : undefined,
          steps: extractFlowSteps(flow.raw),
          currentStepId: summarizeCard(found.cardRaw).currentStepId,
          cardRaw: found.cardRaw
        });

        const { files } = await resolveUsableAttachments(kit, { flowId, cardId }, ids, me, found);
        const presets = allowedTypesOf(field);
        const refused = files.filter((file) => !isFileAllowed(file.mimeType, file.fileName, presets));
        if (refused.length > 0) {
          throw new CangeCliUsageError(
            `Nada foi gravado: o campo "${fieldTitle}" aceita só ${describeAllowedFileTypes(presets)}. ` +
              `Fora do padrão: ${refused.map((file) => `"${file.fileName}"`).join(", ")}.`
          );
        }

        // B1: a lista atual vem da resposta em que o back grava (a mais recente do formulário,
        // rascunho incluído). Lida só do `GET /card/`, o arquivo que a pessoa anexou pela tela
        // na etapa atual (rascunho) sumia: o PUT troca a lista inteira.
        const draft = found.drafts.has(formId) ? found.drafts.get(formId) : await readFormDraft(kit, cardId, formId);
        const current = currentFieldAttachmentIds(found.cardRaw, formId, String(field.id), draft);
        const added = files.filter((file) => !current.includes(file.attachmentId));
        const values = { [field.name]: [...current, ...added.map((file) => file.attachmentId)] };
        const call = { idForm: Number(formId), flowId, cardId, values };

        if (added.length === 0) {
          const noop = {
            cardId,
            flowId,
            field: fieldTitle,
            noop: true,
            summary: `O campo "${fieldTitle}" do cartão ${cardId} já tem esse arquivo: nada a gravar.`
          };
          return options.dryRun ? { dryRun: true, executed: false, calls: [], ...noop } : { ok: true, ...noop };
        }

        if (options.dryRun) {
          return {
            dryRun: true,
            executed: false,
            cardId,
            flowId,
            calls: [
              {
                action: "attachment",
                payload: {
                  cardId,
                  flowId,
                  idForm: call.idForm,
                  fieldId: field.id,
                  fieldTitle,
                  fileNames: added.map((file) => file.fileName),
                  attachmentIds: added.map((file) => file.attachmentId),
                  values
                }
              }
            ],
            note: "Mutação não executada porque --dry-run foi informado."
          };
        }

        await kit.contracts.updateCardValues(call);
        return {
          ok: true,
          cardId,
          flowId,
          field: fieldTitle,
          added: added.map((file) => ({ attachmentId: file.attachmentId, fileName: file.fileName })),
          summary:
            `Cartão ${cardId}: ${added.length === 1 ? `"${added[0]!.fileName}" foi para` : `${added.length} arquivos foram para`} ` +
            `o campo "${fieldTitle}".`
        };
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope:
      "{ ok, cardId, flowId, field, added[{attachmentId, fileName}], summary } (ou noop quando o arquivo já está no campo). " +
      "--dry-run: { dryRun, executed:false, calls[{action:'attachment', payload}] }",
    fieldsLocation:
      "Campo pelo título, id ou hash (só campo de anexo). O arquivo soma aos que o campo já tem. " +
      "Arquivo novo: suba antes com `attachment upload --file <arquivo>` e use o attachmentId.",
    example: 'attachment link-field --card-id 1234 --field "Contrato assinado" --attachment-id 98765'
  });
}

/** O campo de anexo pelo título (sem acento e caixa), id ou hash. */
function pickAttachField(fields: NormalizedField[], ref: string): NormalizedField {
  const wanted = ref.trim();
  const available = (): string => fields.map((field) => `"${field.title ?? field.name}" (id ${String(field.id)})`).join(", ");
  if (wanted === "") {
    throw new CangeCliUsageError(`Informe o campo de anexo em --field. Campos de anexo do fluxo: ${available() || "nenhum"}.`);
  }
  const byId = fields.filter((field) => String(field.id) === wanted.replace(/^#/, "") || field.name === wanted);
  if (byId.length === 1) return byId[0]!;
  const key = normalizeText(wanted);
  const byTitle = fields.filter((field) => normalizeText(field.title ?? "") === key);
  if (byTitle.length === 1) return byTitle[0]!;
  if (byTitle.length > 1) {
    throw new CangeCliUsageError(
      `Há mais de um campo de anexo "${wanted}": use o id. ${byTitle.map((field) => `"${field.title}" (id ${String(field.id)})`).join(", ")}.`
    );
  }
  throw new CangeCliUsageError(
    fields.length === 0
      ? "Este fluxo não tem campo de anexo: para mandar o arquivo, comente com `cange comment create --attachment-id`."
      : `"${wanted}" não é um campo de anexo deste fluxo. Campos de anexo: ${available()}.`
  );
}

/**
 * O cartão grava no formulário do campo? Formulário inicial, da etapa atual ou de uma etapa
 * por onde o cartão já passou (tem resposta). Fora disso o back recusa (422): diz antes.
 */
function assertWritableForm(input: {
  formId: string;
  fieldTitle: string;
  formInitId?: string;
  steps: Array<{ id?: number | string; name?: string; formId?: number | string }>;
  currentStepId?: number | string | null;
  cardRaw: unknown;
}): void {
  if (input.formId === "") {
    throw new CangeCliUsageError(`Não achei o formulário do campo "${input.fieldTitle}".`);
  }
  if (input.formInitId !== undefined && input.formId === input.formInitId) return;
  const current = input.steps.find((step) => String(step.id) === String(input.currentStepId ?? ""));
  if (current && String(current.formId ?? "") === input.formId) return;
  const answers = cardRecordOf(input.cardRaw).form_answers;
  const answered = Array.isArray(answers)
    ? answers.some((answer) => {
        const record = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
        const deleted = typeof record.deleted === "string" && record.deleted.toUpperCase() === "S";
        return !deleted && String(record.form_id ?? record.id_form ?? "") === input.formId;
      })
    : false;
  if (answered) return;
  const owner = input.steps.find((step) => String(step.formId ?? "") === input.formId);
  throw new CangeCliUsageError(
    `Nada foi gravado: o campo "${input.fieldTitle}" é da etapa "${owner?.name ?? "?"}", e o cartão ` +
      `${current?.name ? `está na etapa "${current.name}" e ` : ""}ainda não passou por ela. ` +
      "Mande o arquivo num comentário (`cange comment create --attachment-id`) ou espere o cartão chegar na etapa."
  );
}
