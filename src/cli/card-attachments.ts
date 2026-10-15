/**
 * C2 (onda 1, 14/10/2026): os arquivos de UM cartão nos dois lugares que a pessoa usa,
 * os campos de anexo (formulário) e a colaboração (comentários). Base do
 * `attachment list`, do `attachment download --attachment-id/--from`, do
 * `attachment link-field` e do `comment create --attachment-id`.
 *
 * Leituras (todas com a credencial de quem roda o kit, nenhuma grava):
 *  - `GET /card/` → valores dos campos de anexo em todas as respostas ativas do cartão
 *    (`deleted` = "S" fica de fora), como o `attachment download` sem filtro;
 *  - `GET /form/pre-answer` do formulário da etapa atual → o RASCUNHO da etapa (a resposta
 *    com `flow_step_id` NULL, onde fica o arquivo que a pessoa anexou pela tela antes de
 *    mover). O `GET /card/` não traz o rascunho (`SelectOneFormAnswerService`), e o
 *    `PUT /form/answer` grava nele (`ensureStepFormAnswer`: a resposta mais recente);
 *  - `GET /field/by-flow` → título, formulário e tipos aceitos de cada campo de anexo;
 *  - `GET /card-comment/by-card` → comentários e os anexos de cada um;
 *  - `POST /attachment/batch` → nome, tipo e tamanho dos anexos dos campos (leitura).
 */
import { CangeCliUsageError } from "../client/errors.js";
import type { CangeAgentKit } from "../index.js";
import type { AttachmentRecord } from "../contracts/attachments.js";
import { extractFlowSteps } from "../contracts/payload-builder.js";
import type { NormalizedField } from "../schemas/fields.js";
import { describeAllowedFileTypes, parseAllowedFileTypes, type AttachFileTypePreset } from "../utils/attachFieldTypes.js";

export const ATTACH_FIELD_TYPE = "INPUT_ATTACH_FIELD";

export interface CardFile {
  attachmentId: number;
  fileName: string;
  mimeType?: string;
  /** Tamanho em KB (como o Cange grava). */
  sizeKb?: number;
}

export interface CardFieldFiles {
  fieldId: number | string;
  title: string;
  formId?: string;
  /** Tipos aceitos pelo campo ("PDF, Imagens"); ausente = aceita qualquer tipo. */
  allowedTypes?: string;
  files: CardFile[];
}

export interface CardCommentFiles {
  commentId: number;
  author?: string;
  createdAt?: string;
  files: CardFile[];
}

export interface CardAttachments {
  cardId: number;
  flowId: number;
  fields: CardFieldFiles[];
  comments: CardCommentFiles[];
  /** Campos de anexo do fluxo (para gravar: título, formulário, tipos aceitos). */
  attachFields: NormalizedField[];
  /** O cartão como o `GET /card/` devolveu (para o `link-field` ler a resposta do formulário). */
  cardRaw: unknown;
  /**
   * Rascunho lido por formulário (`GET /form/pre-answer`): o da etapa atual e os pedidos em
   * `draftFormIds`. `undefined` no mapa = o formulário foi lido e não tem rascunho.
   */
  drafts: Map<string, Record<string, unknown> | undefined>;
  /** Quem subiu cada anexo do cartão (id do usuário), quando o back diz. */
  uploaderById: Map<number, number>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is Record<string, unknown> => !!item) : [];
}

function isDeleted(record: Record<string, unknown>): boolean {
  return typeof record.deleted === "string" && record.deleted.trim().toUpperCase() === "S";
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** O registro do cartão dentro do `GET /card/` (o back devolve o cartão ou `{card}`). */
export function cardRecordOf(raw: unknown): Record<string, unknown> {
  const root = asRecord(raw) ?? {};
  if (Array.isArray(root.form_answers)) return root;
  for (const key of ["card", "data", "raw"]) {
    const nested = asRecord(root[key]);
    if (nested && Array.isArray(nested.form_answers)) return nested;
  }
  if (Array.isArray(raw)) return asRecord(raw[0]) ?? {};
  return root;
}

/** Campo de anexo do fluxo que a tela deixa preencher (o "só visualizar" fica de fora, como no download). */
export function isAttachField(field: NormalizedField): boolean {
  if (String(field.type).toUpperCase() !== ATTACH_FIELD_TYPE) return false;
  return String(field.raw?.is_just_view ?? "N").toUpperCase() !== "S";
}

export function allowedTypesOf(field: NormalizedField): AttachFileTypePreset[] {
  return parseAllowedFileTypes(field.raw?.filter_schema);
}

/**
 * Ids de anexo gravados em cada campo de anexo, em todas as respostas ativas do cartão e nos
 * rascunhos lidos (sem repetir).
 */
export function attachmentIdsByField(
  cardRaw: unknown,
  fieldIds: ReadonlySet<string>,
  drafts: Iterable<Record<string, unknown> | undefined> = []
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const answers = [...records(cardRecordOf(cardRaw).form_answers), ...[...drafts].filter((d): d is Record<string, unknown> => !!d)];
  for (const answer of answers) {
    if (isDeleted(answer)) continue;
    for (const row of records(answer.form_answer_fields)) {
      if (isDeleted(row)) continue;
      const field = asRecord(row.field);
      const fieldId = row.field_id ?? row.id_field ?? field?.id_field;
      if (fieldId === undefined || !fieldIds.has(String(fieldId))) continue;
      const id = positiveInt(row.value);
      if (id === undefined) continue;
      const list = out.get(String(fieldId)) ?? [];
      if (!list.includes(id)) list.push(id);
      out.set(String(fieldId), list);
    }
  }
  return out;
}

/**
 * B1 (review do Alex, onda 1): o rascunho do formulário no cartão, como o
 * `GET /form/pre-answer` devolve em `formsAnswers`. Só vale o rascunho de verdade (tem id e
 * `flow_step_id` NULL). Sem rascunho, a rota devolve um objeto montado da última passagem
 * confirmada (`origin: "return-step-autocomplete"`, sem id) e esse objeto deixa de fora os
 * campos de anexo (`RETURN_STEP_AUTOCOMPLETE_BLOCKED_TYPES`); a passagem confirmada o kit lê
 * do `GET /card/`.
 */
export function draftAnswerOf(preRaw: unknown, formId: string): Record<string, unknown> | undefined {
  const answer = asRecord(asRecord(preRaw)?.formsAnswers);
  if (!answer || isDeleted(answer)) return undefined;
  if (answer.origin === "return-step-autocomplete") return undefined;
  if (positiveInt(answer.id_form_answer) === undefined) return undefined;
  if (answer.flow_step_id !== null && answer.flow_step_id !== undefined) return undefined;
  const form = answer.form_id ?? answer.id_form;
  if (form !== undefined && form !== null && String(form) !== formId) return undefined;
  return answer;
}

/**
 * O rascunho do formulário no cartão (`GET /form/pre-answer`). Erro da leitura propaga: sem
 * saber do rascunho, o `link-field` não grava (trocaria a lista e apagaria o arquivo da tela).
 */
export async function readFormDraft(
  kit: CangeAgentKit,
  cardId: number,
  formId: string
): Promise<Record<string, unknown> | undefined> {
  const pre = await kit.contracts.getPreAnswer({ cardId, formId });
  return draftAnswerOf(pre?.raw, formId);
}

/**
 * Ids gravados no campo pela resposta que o `PUT /form/answer` altera: a mais recente do
 * formulário, rascunho incluído (`dt_created`, depois o id), como o `ensureStepFormAnswer`
 * do back. Sem resposta do formulário: lista vazia.
 */
export function currentFieldAttachmentIds(
  cardRaw: unknown,
  formId: string,
  fieldId: string,
  draft?: Record<string, unknown>
): number[] {
  const answers = records(cardRecordOf(cardRaw).form_answers).filter(
    (answer) => !isDeleted(answer) && String(answer.form_id ?? answer.id_form ?? "") === formId
  );
  // O rascunho já foi conferido (`draftAnswerOf`: deste formulário, não excluído).
  if (draft) answers.push(draft);
  answers.sort((a, b) => {
    const ta = Date.parse(String(a.dt_created ?? "")) || 0;
    const tb = Date.parse(String(b.dt_created ?? "")) || 0;
    if (ta !== tb) return tb - ta;
    return (positiveInt(b.id_form_answer) ?? 0) - (positiveInt(a.id_form_answer) ?? 0);
  });
  const latest = answers[0];
  if (!latest) return [];
  const ids: number[] = [];
  for (const row of records(latest.form_answer_fields)) {
    if (isDeleted(row)) continue;
    const field = asRecord(row.field);
    const rowField = row.field_id ?? row.id_field ?? field?.id_field;
    if (String(rowField) !== fieldId) continue;
    const id = positiveInt(row.value);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function fileOf(record: AttachmentRecord | Record<string, unknown>): CardFile | undefined {
  const r = record as Record<string, unknown>;
  const id = positiveInt(r.id_attachment);
  if (id === undefined) return undefined;
  const size = typeof r.blob_size === "number" ? r.blob_size : Number(r.blob_size);
  return {
    attachmentId: id,
    fileName: text(r.original_name) ?? `anexo-${id}`,
    ...(text(r.mime_type) ? { mimeType: String(r.mime_type) } : {}),
    ...(Number.isFinite(size) && size > 0 ? { sizeKb: Math.round(size) } : {})
  };
}

/** Formulário da etapa atual do cartão: o `flow_step` do `GET /card/` ou, sem ele, o fluxo. */
async function currentStepFormId(kit: CangeAgentKit, flowId: number, cardRaw: unknown): Promise<string | undefined> {
  const card = cardRecordOf(cardRaw);
  const step = asRecord(card.flow_step);
  const direct = positiveInt(step?.form_id);
  if (direct !== undefined) return String(direct);
  const stepId = card.flow_step_id ?? step?.id_step;
  if (stepId === undefined || stepId === null) return undefined;
  const flow = await kit.contracts.getFlow({ idFlow: String(flowId) });
  const current = extractFlowSteps(flow.raw).find((item) => String(item.id) === String(stepId));
  return current?.formId !== undefined ? String(current.formId) : undefined;
}

/**
 * Lê os arquivos do cartão (campos de anexo, com o rascunho da etapa atual, e comentários).
 * `draftFormIds`: outros formulários cujo rascunho também deve ser lido (o `link-field` pede
 * o formulário do campo em que vai gravar).
 */
export async function collectCardAttachments(
  kit: CangeAgentKit,
  input: { flowId: number; cardId: number; draftFormIds?: string[] }
): Promise<CardAttachments> {
  const [card, fieldSet, comments] = await Promise.all([
    kit.contracts.getCard({ flowId: input.flowId, cardId: input.cardId }),
    kit.contracts.getFieldsByFlow({ flowId: input.flowId }),
    kit.contracts.listCommentsByCard({ flowId: input.flowId, cardId: input.cardId })
  ]);

  const attachFields = fieldSet.fields.filter(isAttachField);
  const attachForms = new Set(attachFields.map((field) => (field.formId !== undefined ? String(field.formId) : "")));
  const draftForms = new Set(input.draftFormIds ?? []);
  if (attachFields.length > 0) {
    const current = await currentStepFormId(kit, input.flowId, card.raw);
    if (current !== undefined) draftForms.add(current);
  }
  const drafts = new Map<string, Record<string, unknown> | undefined>();
  await Promise.all(
    [...draftForms]
      .filter((formId) => formId !== "" && attachForms.has(formId))
      .map(async (formId) => {
        drafts.set(formId, await readFormDraft(kit, input.cardId, formId));
      })
  );

  const byField = attachmentIdsByField(card.raw, new Set(attachFields.map((field) => String(field.id))), drafts.values());
  const ids = [...new Set([...byField.values()].flat())];
  const { attachments } = await kit.contracts.getAttachmentsByIds({ ids });
  const meta = new Map<number, AttachmentRecord>(attachments.map((item) => [item.id_attachment, item]));
  const uploaderById = new Map<number, number>();
  for (const item of attachments) {
    if (positiveInt(item.user_id) !== undefined) uploaderById.set(item.id_attachment, Number(item.user_id));
  }

  const fields: CardFieldFiles[] = attachFields.map((field) => {
    const allowed = allowedTypesOf(field);
    const files = (byField.get(String(field.id)) ?? [])
      .map((id) => meta.get(id))
      // Id gravado que não volta da empresa (apagado ou de outra empresa): a tela não mostra.
      .filter((item): item is AttachmentRecord => !!item)
      .map(fileOf)
      .filter((item): item is CardFile => !!item);
    return {
      fieldId: field.id ?? field.name,
      title: field.title ?? field.name,
      ...(field.formId !== undefined ? { formId: String(field.formId) } : {}),
      ...(allowed.length > 0 ? { allowedTypes: describeAllowedFileTypes(allowed) } : {}),
      files
    };
  });

  const commentFiles: CardCommentFiles[] = [];
  for (const comment of records(comments.raw)) {
    const commentId = positiveInt(comment.id_card_comment ?? comment.id);
    if (commentId === undefined) continue;
    const files: CardFile[] = [];
    for (const attachment of records(comment.attachments)) {
      const file = fileOf(attachment);
      if (!file) continue;
      files.push(file);
      const uploader = positiveInt(attachment.user_id);
      if (uploader !== undefined) uploaderById.set(file.attachmentId, uploader);
    }
    if (files.length === 0) continue;
    const user = asRecord(comment.user);
    commentFiles.push({
      commentId,
      ...(text(user?.name) ? { author: String(user!.name) } : {}),
      ...(text(comment.dt_created_string) ?? text(comment.dt_created)
        ? { createdAt: String(text(comment.dt_created_string) ?? text(comment.dt_created)) }
        : {}),
      files
    });
  }

  return {
    cardId: input.cardId,
    flowId: input.flowId,
    fields,
    comments: commentFiles,
    attachFields,
    cardRaw: card.raw,
    drafts,
    uploaderById
  };
}

/** Todos os anexos do cartão (campos e comentários), sem repetir, com a origem. */
export function cardFilesIndex(attachments: CardAttachments): Map<number, { file: CardFile; where: string }> {
  const out = new Map<number, { file: CardFile; where: string }>();
  for (const field of attachments.fields) {
    for (const file of field.files) {
      if (!out.has(file.attachmentId)) out.set(file.attachmentId, { file, where: `campo "${field.title}"` });
    }
  }
  for (const comment of attachments.comments) {
    for (const file of comment.files) {
      if (!out.has(file.attachmentId)) out.set(file.attachmentId, { file, where: `comentário ${comment.commentId}` });
    }
  }
  return out;
}

/**
 * Usuário da credencial (o bot do agente, no run): o `sub` do JWT é o JSON do login do
 * Cange (`{"id_user": ...}`). Sem token legível: undefined (quem chama falha fechado).
 */
export function userIdFromToken(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
    const direct = positiveInt(payload.id_user);
    if (direct !== undefined) return direct;
    const sub = typeof payload.sub === "string" ? JSON.parse(payload.sub) : payload.sub;
    return positiveInt(asRecord(sub)?.id_user);
  } catch {
    return undefined;
  }
}

/** Lista de ids (`--attachment-id 1,2` ou repetido) → inteiros positivos, sem repetir. */
export function parseAttachmentIds(values: string[] | string | undefined): number[] | { invalid: string } {
  const list = (Array.isArray(values) ? values : values === undefined ? [] : [values])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().replace(/^#/, ""))
    .filter((value) => value !== "");
  const ids: number[] = [];
  for (const value of list) {
    const id = positiveInt(value);
    if (id === undefined || !/^\d+$/.test(value)) return { invalid: value };
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Anexos que o agente pode pôr no cartão (comentário ou campo): os que ele mesmo subiu
 * (`user_id` do anexo = usuário da credencial) ou os que já estão neste cartão (campo ou
 * comentário). Assim um id solto de outro fluxo da empresa (texto de cartão, palpite)
 * não vira arquivo visível em outro lugar. Qualquer id fora da regra = exit 2, nada gravado.
 */
export async function resolveUsableAttachments(
  kit: CangeAgentKit,
  target: { flowId: number; cardId: number },
  ids: number[],
  me: number | undefined,
  preloaded?: CardAttachments
): Promise<{ files: CardFile[]; attachments?: CardAttachments }> {
  const { attachments: found } = await kit.contracts.getAttachmentsByIds({ ids });
  const byId = new Map<number, AttachmentRecord>(found.map((item) => [item.id_attachment, item]));
  const own = (id: number): boolean => me !== undefined && positiveInt(byId.get(id)?.user_id) === me;

  let attachments = preloaded;
  if (!attachments && ids.some((id) => byId.has(id) && !own(id))) {
    attachments = await collectCardAttachments(kit, target);
  }
  const index = attachments ? cardFilesIndex(attachments) : new Map<number, { file: CardFile; where: string }>();

  const files: CardFile[] = [];
  const problems: string[] = [];
  for (const id of ids) {
    const record = byId.get(id);
    if (!record) {
      problems.push(`o anexo ${id} não existe (ou é de outra empresa)`);
      continue;
    }
    if (!own(id) && !index.has(id)) {
      problems.push(`o anexo ${id} não está no cartão ${target.cardId} e não foi você que subiu`);
      continue;
    }
    const file = fileOf(record);
    if (file) files.push(file);
  }
  if (problems.length > 0) {
    throw new CangeCliUsageError(
      `Nada foi gravado: ${problems.join("; ")}. Para um arquivo novo, suba com \`cange attachment upload --file <arquivo>\` ` +
        "e use o attachmentId que ele devolve; para um anexo do cartão, veja os ids em `cange attachment list --card-id <id>`."
    );
  }
  return { files, ...(attachments ? { attachments } : {}) };
}
