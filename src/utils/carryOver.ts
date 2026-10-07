import { asRecord } from "../contracts/raw-adapters.js";
import type { NormalizedField } from "../schemas/fields.js";

import { normalizeFieldType } from "./fieldTypeGuards.js";
import { isEmptyForField, isRichTextType } from "./requiredFields.js";

/**
 * P5 (05/10, card #1367456): o mover em 1 passo REENVIA os campos já preenchidos
 * do formulário da etapa atual, como a tela faz.
 *
 * O `POST /card/v2/move-step` grava um form_answer NOVO só com o que vier em
 * `values` (a tela manda o formulário inteiro da etapa, já carregado com o que o
 * cartão tem). Mandar só o campo novo esvaziaria os outros no snapshot. Aqui o
 * kit remonta o valor gravado de cada campo do formulário, no formato que o back
 * aceita de volta. Tipo que não dá para remontar com segurança (ID automático,
 * fórmula, e anexo fora da pré-resposta) vai para `notKept`: o comando avisa e
 * `--fail-on-data-loss` bloqueia.
 *
 * EXTRA-06 D1 (07/10/2026, P0): a FONTE do que o cartão tem na etapa é a mesma da tela,
 * o `GET /form/pre-answer?card_id=&id_form=<form da etapa atual>`:
 *  - o rascunho da etapa (form_answer com `flow_step_id` NULL: o autosave da tela, e o
 *    que automação e `card update-values` gravam nele) quando existe;
 *  - sem rascunho, a última passagem confirmada do mesmo formulário (o back monta;
 *    `origin = "return-step-autocomplete"`).
 * O `GET /card` não traz o rascunho: o kit via campo vazio que a tela mostra preenchido
 * (falso "Falta" no mover) e, pior, o mover apaga o rascunho (`/card/v2/move-step`) e o
 * que estava só nele sumia. Agora o que está no rascunho é contado e reenviado.
 *
 * Rascunho x resposta confirmada mais nova (F1 da revisão, 07/10): decide por CAMPO e pela
 * recência da LINHA (`form_answer_field.dt_last_update`, no empate o `id_form_answer_field`),
 * não pelo `dt_created` do form_answer. O autosave da tela (`POST /form/pre-new-answer`)
 * regrava as linhas do rascunho sem mudar o form_answer: um rascunho criado antes e editado
 * depois da confirmada é o valor que a tela mostra (cartão 1107439: 18:30 no rascunho
 * editado em 08/07 contra 18:00 na confirmada de 07/07). A confirmada só vence quando a
 * linha dela é a mais nova, que é o caso do `card update-values` (o `PUT /form/answer`
 * grava na resposta mais recente, e esse valor não pode sumir no mover).
 *
 * Autocompletar da tela (F2 da revisão): a tela preenche o campo SEM linha na pré-resposta
 * com o autocompletar dele (`getAutoCompleteRule('answer')`) e manda esse valor no mover.
 * O kit faz igual (`applyAutoComplete`): estático, data atual, criador do cartão, o valor
 * de outro campo do cartão e a opção pelo rótulo (o texto da origem casado com o rótulo da
 * opção). Origem vazia no cartão: a tela não preenche nada e o obrigatório cobra; o kit
 * também (A2-F1, 07/10). O que o kit não calcula (usuário atual, campo de vínculo com a
 * origem preenchida, rótulo de origem que o kit não sabe montar) vai para `autoPending` e o
 * obrigatório vazio vira aviso.
 *
 * A rota respondeu SEM nada (nem rascunho com linha, nem última passagem elegível): a tela
 * abre o formulário vazio, só com o autocompletar (`usePreAnswer`, ramo "No existing
 * answers"), e o kit também (`vazio`). Antes o kit caía no `GET /card` e contava o que a
 * tela não mostra: anexo da passagem anterior (o back não reaproveita anexo entre
 * passagens) e valor de passagem mais antiga quando a última veio sem linha (184 cartões
 * ativos no cange_local, 07/10). Só sem a rota (404, back antigo) vale o `GET /card`.
 *
 * Anexo e botão da pré-resposta (07/10, revalidação do EXTRA-06): a tela também os manda
 * no mover (o InputAttach devolve a lista de `id_attachment`, o botão o JSON do último
 * clique) e o back grava as mesmas linhas na resposta nova. O kit faz igual com o que veio
 * da pré-resposta (`PRE_ANSWER_ONLY_TYPES`). Antes ficavam em `notKept`: o anexo que a
 * pessoa subiu na etapa, que só existe no rascunho, sumia no mover (1.549 cartões ativos
 * no cange_local com anexo no rascunho da etapa atual). Da confirmada mais nova que o
 * rascunho e do `GET /card` eles seguem fora (a tela não os mostra; o back não reaproveita
 * anexo entre passagens), e o autocompletar de anexo segue pendente.
 *
 * Revisão 3 do EXTRA-06 (07/10):
 *  - R3-F1 (passagem atual): na disputa rascunho x confirmada mais nova, só conta a LINHA da
 *    confirmada escrita desde que o cartão entrou na etapa em que está (`stepEntry`, do
 *    `GET /card/moviment`). O rascunho dura várias passagens (no V1 o back não o apaga ao sair),
 *    e a resposta do formulário público que tirou o cartão da etapa é "mais nova" que ele: o
 *    valor dela voltava no mover por cima do campo que a pessoa limpou no rascunho (cartão
 *    799470: "Você aprova a arte abaixo?" = NÃO de uma rodada anterior). Linha anterior à
 *    entrada fica fora, como na tela (ela só lê o rascunho). Sem a entrada (rota ausente ou
 *    sem movimento), nenhuma confirmada disputa.
 *  - R3-F2 (linha repetida): o rascunho pode ter duas linhas do mesmo campo no mesmo `index`
 *    (corrida do autosave). A tela (`formAnswerToObjectFormInit`) fica com a primeira pela chave
 *    resposta-campo-index; o kit juntava as duas, não conseguia remontar o campo de valor único
 *    e o mover o deixava vazio (cartão 55241: 3 obrigatórios). Agora o kit descarta a repetida
 *    igual (rascunho, última passagem e confirmadas).
 *  - R3-F4 (vínculo com a origem no mover): origem vazia no cartão, mas mandada no mover (o
 *    `sent`), do mesmo formulário e de cadastro ou cartão: a tela preenche o destino no blur
 *    (`POST /form/answers/by-register` com o valor escolhido). O kit pede o mesmo
 *    (`byRegister`, resolvido pelo `resolveByRegister`) e leva o valor (`autoFilled`).
 */

/** De onde veio o que o cartão tem na etapa atual. */
export type CarrySource = "rascunho" | "ultima-passagem" | "vazio" | "cartao";

/** Regra do autocompletar que deu o valor (o que a tela faria no campo sem valor). */
export type AutoFillRule = "estatico" | "data-atual" | "criador-do-cartao" | "campo-do-cartao" | "opcao-pelo-rotulo" | "vinculo";

export interface CarryOverResult {
  /** hash → valor remontado, pronto para o `values` do mover (autocompletar incluído). */
  values: Record<string, unknown>;
  /** hashes preenchidos hoje no cartão (contam como presentes nos obrigatórios). */
  filled: Set<string>;
  /** Preenchidos que não dá para reenviar (o mover deixa vazios no snapshot novo). */
  notKept: Array<{ name: string; title?: string }>;
  /**
   * `rascunho` = pré-resposta da etapa (o mover apaga), `ultima-passagem` = o que o back remonta,
   * `vazio` = a rota respondeu sem nada (a tela abre o formulário vazio), `cartao` = GET /card (back sem a rota).
   */
  source: CarrySource;
  /** Valor gravado em texto por campo (detector de perda de dados). */
  stored: Map<string, string>;
  /** Campos com linha gravada na fonte, mesmo vazia (a tela não autocompleta esses). */
  answered: Set<string>;
  /** Campos sem valor que o autocompletar da tela preenche; o valor já está em `values`. */
  autoFilled: Array<{ name: string; title?: string; rule: AutoFillRule }>;
  /** Campos sem valor com autocompletar que o kit não calcula: obrigatório vazio vira aviso. */
  autoPending: Array<{ name: string; title?: string; reason: string }>;
  /**
   * R3-F4: destinos de vínculo cuja origem vazia no cartão vem no mover. A tela preenche no
   * blur pelo `POST /form/answers/by-register`; quem lê a pré-resposta pede e aplica com
   * `resolveByRegister`. Até lá o campo fica em `autoPending` (aviso, não bloqueio).
   */
  byRegister: RegisterAutoFill[];
}

/** Pedido do autocompletar de vínculo com a origem mandada no mover (R3-F4). */
export interface RegisterAutoFill {
  /** Campo destino (hash). */
  name: string;
  title?: string;
  /** Campo de origem (o combo de cadastro ou de cartão do mesmo formulário). */
  parentFieldId: number;
  /** Campo do cadastro/cartão apontado que dá o valor (`ac_child_field_id`). */
  childFieldId: number;
  /** O que vai no mover para a origem (os ids escolhidos), como o `currValue` da tela. */
  currValue: unknown;
  /** Opções do destino (lista de opções: casa o `valueString` com o rótulo). */
  options?: unknown;
}

const MULTI_ID_TYPES = new Set(["COMBO_BOX_REGISTER_FIELD", "REGISTER_FIELD", "COMBO_BOX_FLOW_FIELD", "FLOW_FIELD"]);
const MULTI_TEXT_TYPES = new Set(["CHECK_BOX_FIELD", "CHECKBOX_FIELD"]);
/**
 * Lista de itens e check list: o back grava 1 linha por item (`index` = `value` do item,
 * `value` = `label`). Reenviar `{ value: <index>, label: <valor> }` refaz as mesmas
 * linhas (`CreateFormAnswerService`, ramo INPUT_LIST/CHECK_LIST). No check list o
 * `label` é o item em JSON, com o `checked`.
 */
const ITEM_LIST_TYPES = new Set(["CHECK_LIST_FIELD", "INPUT_LIST_FIELD"]);
/**
 * Reenviados só quando vêm da pré-resposta (rascunho ou última passagem), igual à tela:
 * anexo como a lista de ids (`id_attachment`, o que o InputAttach manda) e botão como o
 * texto gravado (o JSON do último clique, o que o ButtonField manda).
 */
const PRE_ANSWER_ONLY_TYPES = new Set(["INPUT_ATTACH_FIELD", "BUTTON_FIELD"]);
const NUMBER_TYPES = new Set(["NUMBER_FIELD", "NUMERIC_FIELD", "CURRENCY_FIELD", "MONEY_FIELD"]);
const USER_TYPES = new Set(["COMBO_BOX_USER_FIELD", "USER_FIELD", "REQUESTER_FIELD"]);
const BOOLEAN_TYPES = new Set(["SWITCH_FIELD", "TOGGLE_FIELD"]);
const SINGLE_TEXT_TYPES = new Set([
  "TEXT_SHORT_FIELD",
  "TEXT_LONG_FIELD",
  "RICH_TEXT_FIELD",
  "INPUT_RICH_TEXT_FIELD",
  "DYNAMIC_TEXT_FIELD",
  "HTML_FIELD",
  "PHONE_FIELD",
  "PHONE_NUMBER_FIELD",
  "DOC_FIELD",
  "DOCUMENT_FIELD",
  "LINK_FIELD",
  "URL_FIELD",
  "MAIL_FIELD",
  "EMAIL_FIELD",
  "DATE_PICKER_FIELD",
  "DUE_DATE_FIELD",
  "DATE_FIELD",
  "COMBO_BOX_FIELD",
  "RADIO_BOX_FIELD"
]);

/** Origem do form_answer sintético que o back monta sem rascunho (BuildReturnStepAutocompleteService). */
const SYNTHETIC_ORIGIN = "return-step-autocomplete";

/** Recência de uma linha: [data da linha em ms, id_form_answer_field, ordem da resposta]. */
type Recency = [number, number, number];

interface StoredField {
  /** Valores da resposta que vence o campo, na ordem do `index`. */
  items: Array<{ index: number; value: string }>;
  /** A linha mais nova do campo nesta resposta (campo de várias linhas: a maior). */
  recency: Recency;
}

/** Como escolher, por campo, entre as respostas: a mais recente que traz o campo, ou a linha mais nova. */
type MergeMode = "resposta" | "linha";

/** Só o `GET /card` (respostas confirmadas): o mais recente vence por campo. */
export function readCarryOver(cardRaw: unknown, formId: string, fields: NormalizedField[]): CarryOverResult {
  return build(confirmedAnswers(cardRaw, formId), fields, "cartao");
}

export interface StepCarryOverInput {
  /** Resposta do `GET /card` (respostas confirmadas). */
  cardRaw: unknown;
  /** Resposta do `GET /form/pre-answer` da etapa atual (`{ fields, formsAnswers }`); undefined = rota ausente. */
  preAnswerRaw: unknown;
  formId: string;
  fields: NormalizedField[];
  /**
   * Campos do fluxo inteiro (`GET /field/by-flow`): as opções do campo de origem do
   * autocompletar, para achar o rótulo da linha do rascunho (que vem sem `valueString`).
   */
  flowFields?: NormalizedField[];
  /**
   * Aplicar o autocompletar da tela (padrão: sim). Não no formulário que o mover grava fora
   * da etapa atual: a tela só autocompleta quando o cartão estiver na etapa dele.
   */
  autoComplete?: boolean;
  /**
   * R3-F1: quando o cartão entrou na etapa em que está (ms; o `dt_entry` mais novo do
   * `GET /card/moviment`). Só a linha de confirmada escrita desde então disputa com o
   * rascunho. undefined = não se sabe: nenhuma confirmada disputa (a tela só lê o rascunho).
   */
  stepEntry?: number;
  /** R3-F4: o que vai no mover para este formulário (hash → valor), para o autocompletar de vínculo. */
  sent?: Record<string, unknown>;
}

/** O que o cartão tem no formulário da etapa atual, pela mesma fonte da tela (ver o topo). */
export function readStepCarryOver(input: StepCarryOverInput): CarryOverResult {
  const pre = preAnswerRecord(input.preAnswerRaw, input.formId);
  let result: CarryOverResult;
  let draft: Record<string, unknown> | undefined;
  if (!pre) {
    // Sem a rota (404): o GET /card, como antes. A rota respondeu sem nada: vazio, como a tela.
    result =
      input.preAnswerRaw === undefined
        ? readCarryOver(input.cardRaw, input.formId, input.fields)
        : build([], input.fields, "vazio");
  } else if (String(pre.origin ?? "") === SYNTHETIC_ORIGIN || firstDefined(pre.id_form_answer, pre.id) === undefined) {
    result = build([pre], input.fields, "ultima-passagem", "resposta", true);
  } else {
    draft = pre;
    // Só a confirmada mais nova que o rascunho disputa com ele (é nela que o PUT /form/answer
    // grava quando o rascunho é mais antigo); a disputa é campo a campo, pela linha (F1).
    // E só no campo que o mover reenvia: a disputa existe para o valor gravado nela não sumir
    // no mover. Anexo, fórmula e ID automático o mover não leva e a tela não mostra (ela só lê
    // o rascunho): ficam como na tela. Cartão 896192 (07/10): anexos da resposta do formulário
    // público da etapa, mais nova que o rascunho, contavam como preenchidos; a tela os cobra.
    // Anexo e botão do rascunho vão no mover (como a tela); os da confirmada mais nova não
    // entram aqui (`onlyResendableRows` os tira), então só o rascunho os fornece.
    // R3-F1: e só a linha escrita nesta passagem (desde a entrada na etapa). A resposta de uma
    // passagem anterior (a que tirou o cartão da etapa, o formulário público da rodada passada)
    // não volta por cima do que a pessoa limpou no rascunho.
    const newer = newerConfirmed(input.cardRaw, input.formId, pre)
      .map((answer) => onlyResendableRows(answer, input.fields))
      .map((answer) => onlyRowsSince(answer, input.stepEntry));
    result = build([pre, ...newer], input.fields, "rascunho", "linha", true);
  }
  // A rota respondeu: os `fields` dela trazem o autocompletar de cada campo, como a tela usa.
  if (input.preAnswerRaw !== undefined && input.autoComplete !== false) {
    applyAutoComplete(result, {
      preFields: asRecord(input.preAnswerRaw)?.fields,
      cardRaw: input.cardRaw,
      fields: input.fields,
      ...(input.flowFields ? { flowFields: input.flowFields } : {}),
      ...(draft ? { draft } : {}),
      ...(input.sent ? { sent: input.sent } : {})
    });
  }
  return result;
}

/** Confirmadas do formulário mais novas que o rascunho (as únicas que podem disputar com ele). */
function newerConfirmed(cardRaw: unknown, formId: string, draft: Record<string, unknown>): Array<Record<string, unknown>> {
  return confirmedAnswers(cardRaw, formId).filter((answer) => isNewer(answer, draft));
}

/**
 * R3-F1: o kit precisa da entrada do cartão na etapa (`stepEntry`) só quando há rascunho e uma
 * confirmada mais nova que ele com linha de campo que o mover reenvia. Sem isso, não consulta.
 */
export function needsStepEntry(input: Pick<StepCarryOverInput, "cardRaw" | "preAnswerRaw" | "formId" | "fields">): boolean {
  const pre = preAnswerRecord(input.preAnswerRaw, input.formId);
  if (!pre || String(pre.origin ?? "") === SYNTHETIC_ORIGIN || firstDefined(pre.id_form_answer, pre.id) === undefined) return false;
  return newerConfirmed(input.cardRaw, input.formId, pre).some(
    (answer) => toArray(onlyResendableRows(answer, input.fields).form_answer_fields).length > 0
  );
}

/**
 * A entrada na etapa atual pelos movimentos do cartão (`GET /card/moviment`): o `dt_entry` mais
 * novo. O cartão está na etapa desde o último movimento registrado (se o último fosse de outra
 * etapa, ele voltou depois, então é um limite por baixo). Sem movimento legível: undefined.
 */
export function stepEntryFromMovements(raw: unknown): number | undefined {
  const root = asRecord(raw);
  const list = Array.isArray(raw) ? raw : toArray(root?.data ?? root?.items ?? root?.movements);
  let latest: number | undefined;
  for (const item of list) {
    const time = parseTime(asRecord(item)?.dt_entry);
    if (time !== undefined && (latest === undefined || time > latest)) latest = time;
  }
  return latest;
}

/** A resposta só com as linhas escritas desde `since` (sem `since`, nenhuma). */
function onlyRowsSince(answer: Record<string, unknown>, since: number | undefined): Record<string, unknown> {
  if (since === undefined) return { ...answer, form_answer_fields: [] };
  const rows = toArray(answer.form_answer_fields).filter((item) => {
    const record = asRecord(item);
    if (!record) return false;
    const time = parseTime(record.dt_last_update) ?? parseTime(record.dt_created) ?? parseTime(answer.dt_created);
    return time !== undefined && time >= since;
  });
  return { ...answer, form_answer_fields: rows };
}

/** Campo que o mover consegue reenviar (o kit remonta o valor gravado; ver `rebuild`). */
function isResendableType(field: NormalizedField): boolean {
  const type = normalizeFieldType(field.type);
  return (
    MULTI_ID_TYPES.has(type) ||
    MULTI_TEXT_TYPES.has(type) ||
    ITEM_LIST_TYPES.has(type) ||
    NUMBER_TYPES.has(type) ||
    USER_TYPES.has(type) ||
    BOOLEAN_TYPES.has(type) ||
    SINGLE_TEXT_TYPES.has(type)
  );
}

/** A resposta só com as linhas de campo que o mover reenvia (as outras não disputam com o rascunho). */
function onlyResendableRows(answer: Record<string, unknown>, fields: NormalizedField[]): Record<string, unknown> {
  const byId = new Map<string, NormalizedField>();
  const byName = new Map<string, NormalizedField>();
  for (const field of fields) {
    if (field.id !== undefined) byId.set(String(field.id), field);
    byName.set(field.name, field);
  }
  const rows = toArray(answer.form_answer_fields).filter((item) => {
    const record = asRecord(item);
    if (!record) return false;
    const fieldRecord = asRecord(record.field);
    const fieldId = firstDefined(record.field_id, record.id_field, fieldRecord?.id_field, fieldRecord?.id);
    const field =
      (fieldId !== undefined ? byId.get(String(fieldId)) : undefined) ??
      (typeof fieldRecord?.name === "string" ? byName.get(fieldRecord.name) : undefined);
    return field !== undefined && isResendableType(field);
  });
  return { ...answer, form_answer_fields: rows };
}

/** `formsAnswers` da pré-resposta, quando é deste formulário e tem campo gravado. */
function preAnswerRecord(raw: unknown, formId: string): Record<string, unknown> | undefined {
  const root = asRecord(raw);
  if (!root) return undefined;
  const answer = asRecord(root.formsAnswers ?? root.formAnswer ?? asRecord(root.raw)?.formsAnswers);
  if (!answer || isDeleted(answer)) return undefined;
  const answerForm = firstDefined(answer.form_id, answer.id_form);
  if (answerForm !== undefined && String(answerForm) !== formId) return undefined;
  const rows = toArray(answer.form_answer_fields)
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== undefined && !isDeleted(row));
  return rows.length > 0 ? answer : undefined;
}

function confirmedAnswers(cardRaw: unknown, formId: string): Array<Record<string, unknown>> {
  const card = findCardRecord(cardRaw);
  if (!card) return [];
  return toArray(card.form_answers)
    .map(asRecord)
    .filter((answer): answer is Record<string, unknown> => answer !== undefined)
    .filter((answer) => String(answer.form_id ?? answer.id_form) === formId)
    .filter((answer) => !isDeleted(answer))
    .sort(compareByRecencyAsc);
}

/**
 * `answers` do mais antigo para o mais recente. Modo `resposta`: a mais recente que traz o
 * campo vence. Modo `linha` (rascunho x confirmadas): vence a resposta com a linha mais nova
 * do campo (`dt_last_update`, depois `id_form_answer_field`, depois a ordem da resposta).
 */
function build(
  answers: Array<Record<string, unknown>>,
  fields: NormalizedField[],
  source: CarrySource,
  mode: MergeMode = "resposta",
  fromPreAnswer = false
): CarryOverResult {
  const result: CarryOverResult = {
    values: {},
    filled: new Set(),
    notKept: [],
    source,
    stored: new Map(),
    answered: new Set(),
    autoFilled: [],
    autoPending: [],
    byRegister: []
  };

  const byId = new Map<string, NormalizedField>();
  const byName = new Map<string, NormalizedField>();
  for (const field of fields) {
    if (field.id !== undefined) byId.set(String(field.id), field);
    byName.set(field.name, field);
  }

  const stored = new Map<string, StoredField>();
  answers.forEach((answer, order) => {
    const perAnswer = new Map<string, StoredField>();
    // R3-F2: linha repetida (mesmo campo e mesmo index na resposta) fica de fora, a primeira
    // vale, como a chave resposta-campo-index do `formAnswerToObjectFormInit` da tela.
    const seen = new Set<string>();
    for (const item of toArray(answer.form_answer_fields)) {
      const record = asRecord(item);
      if (!record || isDeleted(record)) continue;
      const fieldRecord = asRecord(record.field);
      const fieldId = firstDefined(record.field_id, record.id_field, fieldRecord?.id_field, fieldRecord?.id);
      if (fieldId !== undefined && "index" in record) {
        const key = `${String(fieldId)}-${String(record.index)}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const field =
        (fieldId !== undefined ? byId.get(String(fieldId)) : undefined) ??
        (typeof fieldRecord?.name === "string" ? byName.get(fieldRecord.name) : undefined);
      if (!field) continue;
      const value = asString(record.value);
      const recency = lineRecency(record, answer, order);
      const entry = perAnswer.get(field.name) ?? { items: [], recency };
      if (compareRecency(recency, entry.recency) > 0) entry.recency = recency;
      if (value !== undefined && value.trim().length > 0) {
        entry.items.push({ index: Number(record.index ?? entry.items.length) || 0, value });
      }
      perAnswer.set(field.name, entry);
    }
    for (const [name, entry] of perAnswer) {
      const current = stored.get(name);
      if (mode === "resposta" || !current || compareRecency(entry.recency, current.recency) > 0) stored.set(name, entry);
    }
  });

  for (const [name, entry] of stored) {
    result.answered.add(name);
    if (entry.items.length === 0) continue;
    const field = byName.get(name)!;
    const items = entry.items.sort((a, b) => a.index - b.index);
    const texts = items.map((item) => item.value);
    // D4: rich text sem conteúdo (`<p></p>`) não conta como preenchido (a tela trata como vazio).
    const empty = isRichTextType(field.type) && isEmptyForField(field, texts);
    if (!empty) {
      result.filled.add(name);
      result.stored.set(name, texts.join(", "));
    }
    const rebuilt = rebuild(field, items, fromPreAnswer);
    if (rebuilt === undefined) {
      if (!empty) result.notKept.push({ name, ...(field.title ? { title: field.title } : {}) });
    } else {
      result.values[name] = rebuilt;
    }
  }
  return result;
}

/** Data da linha (a da última edição, senão a de criação, senão a da resposta), o id e a ordem. */
function lineRecency(record: Record<string, unknown>, answer: Record<string, unknown>, order: number): Recency {
  const time = parseTime(record.dt_last_update) ?? parseTime(record.dt_created) ?? parseTime(answer.dt_created) ?? 0;
  const id = Number(firstDefined(record.id_form_answer_field, record.id) ?? 0);
  return [time, Number.isFinite(id) ? id : 0, order];
}

function compareRecency(a: Recency, b: Recency): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

// ---------------------------------------------------------------------------
// Autocompletar da tela (F2)
// ---------------------------------------------------------------------------

/** Destino lista de opções: a tela casa o TEXTO da origem (`valueString`) com o rótulo da opção. */
const OPTION_TYPES = new Set(["COMBO_BOX_FIELD", "RADIO_BOX_FIELD", "CHECK_BOX_FIELD", "CHECKBOX_FIELD"]);
/** Lista de opções de um valor só: duas opções casadas o kit não sabe qual a tela mostra. */
const SINGLE_OPTION_TYPES = new Set(["COMBO_BOX_FIELD", "RADIO_BOX_FIELD"]);
const DATE_TYPES = new Set(["DATE_PICKER_FIELD", "DUE_DATE_FIELD", "DATE_FIELD"]);
/**
 * Tipos em que o texto que o back monta (`getCardsNormalize`, o `valueString`) NÃO é o valor
 * gravado: nome do usuário, máscara de documento, data em dd/MM/yyyy, moeda, título do
 * cadastro/cartão, nome do anexo. Sem o `valueString` na linha, o kit não sabe o texto.
 */
const FORMATTED_TEXT_TYPES = new Set([
  "COMBO_BOX_USER_FIELD",
  "REQUESTER_FIELD",
  "ID_FIELD",
  "DOC_FIELD",
  "SWITCH_FIELD",
  "DATE_PICKER_FIELD",
  "DUE_DATE_FIELD",
  "CURRENCY_FIELD",
  "COMBO_BOX_REGISTER_FIELD",
  "COMBO_BOX_FLOW_FIELD",
  "INPUT_ATTACH_FIELD"
]);

interface AutoCompleteInput {
  /** `fields` do `GET /form/pre-answer` (com `ac_type`, `ac_parent_field_id`, `auto_complete`). */
  preFields: unknown;
  cardRaw: unknown;
  fields: NormalizedField[];
  /** Campos do fluxo (opções do campo de origem). */
  flowFields?: NormalizedField[];
  /** O rascunho da etapa (a tela também lê o campo de origem nele). */
  draft?: Record<string, unknown>;
  /** R3-F4: o que vai no mover para este formulário. */
  sent?: Record<string, unknown>;
}

/** Linha com valor do campo de origem, na ordem do `index`. */
interface ParentRow {
  index: number;
  value: string;
  row: Record<string, unknown>;
}

/**
 * Igual ao `usePreAnswer` + `getAutoCompleteRule('answer')` da tela: campo do formulário sem
 * linha no que o cartão tem recebe o valor do autocompletar dele, e esse valor vai no mover.
 *  - `ac_type = 1` (estático): as linhas de `auto_complete.form_answer_fields`;
 *  - `ac_type = 0` e `ac_parent_field_id`: `-1` data atual, `-3` criador do cartão, `> 0` o
 *    valor desse campo no cartão (a resposta mais recente que o traz, rascunho incluído);
 *    destino lista de opções: a opção cujo rótulo é o texto da origem (sem diferenciar
 *    maiúscula), como a tela; rótulo que não casa deixa o campo vazio.
 * Origem `> 0` sem valor no cartão (A2-F1): o `POST /form/answers/by-cards` da tela volta sem
 * linha, a tela não preenche e o obrigatório cobra. O kit deixa o campo vazio e FORA do
 * `autoPending`, para bloquear igual (antes o vínculo e a opção pelo rótulo viravam aviso
 * sempre: cartão 233055, "Urgência" com o campo de origem vazio).
 * Fica em `autoPending` (o kit não calcula): `-2` usuário atual (quem abre a tela), campo de
 * vínculo (`ac_child_field_id`) com a origem preenchida (o valor vem do cadastro ou cartão
 * apontado) e opção pelo rótulo quando o kit não sabe o texto da origem.
 */
function applyAutoComplete(result: CarryOverResult, input: AutoCompleteInput): void {
  const preFields = toArray(input.preFields)
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== undefined);
  if (preFields.length === 0) return;
  const byId = new Map<string, Record<string, unknown>>();
  const byName = new Map<string, Record<string, unknown>>();
  for (const record of preFields) {
    const id = firstDefined(record.id_field, record.id);
    if (id !== undefined) byId.set(String(id), record);
    if (typeof record.name === "string") byName.set(record.name, record);
  }

  for (const field of input.fields) {
    if (result.answered.has(field.name) || field.name in result.values) continue;
    const raw = (field.id !== undefined ? byId.get(String(field.id)) : undefined) ?? byName.get(field.name);
    if (!raw) continue;
    const title = field.title ? { title: field.title } : {};
    const pending = (reason: string): void => {
      result.autoPending.push({ name: field.name, ...title, reason });
    };
    const fill = (items: Array<{ index: number; value: string }>, rule: AutoFillRule): void => {
      const rebuilt = rebuild(field, items);
      if (rebuilt === undefined) return pending("tipo que o kit não remonta");
      if (isEmptyForField(field, rebuilt)) return;
      result.values[field.name] = rebuilt;
      result.autoFilled.push({ name: field.name, ...title, rule });
    };

    const acType = toInteger(raw.ac_type);
    if (acType === 1) {
      const fieldId = firstDefined(raw.id_field, field.id);
      const items = valueItems(
        toArray(asRecord(raw.auto_complete)?.form_answer_fields).filter((item) => {
          const row = asRecord(item);
          const rowField = row ? firstDefined(row.field_id, row.id_field) : undefined;
          return rowField === undefined || fieldId === undefined || String(rowField) === String(fieldId);
        })
      );
      if (items.length > 0) fill(items, "estatico");
      continue;
    }
    if (acType !== 0) continue;
    const parent = toInteger(raw.ac_parent_field_id);
    if (parent === undefined || parent === 0) continue;
    if (parent === -1) {
      fill([{ index: 0, value: new Date().toISOString() }], "data-atual");
    } else if (parent === -3) {
      const creator = toInteger(findCardRecord(input.cardRaw)?.user_id_creator);
      if (creator !== undefined && creator > 0) fill([{ index: 0, value: String(creator) }], "criador-do-cartao");
      else pending("criador do cartão");
    } else if (parent === -2) {
      pending("usuário atual");
    } else if (parent > 0) {
      const rows = parentFieldRows(input.cardRaw, input.draft, parent);
      // Origem sem valor: a tela não preenche nada ao abrir e o obrigatório cobra (A2-F1). Mas
      // origem de vínculo do mesmo formulário escolhida no mover: a tela preenche no blur (R3-F4).
      if (!rows) {
        const request = registerRequest(field, raw, parent, input);
        if (request) {
          result.byRegister.push(request);
          pending("campo de vínculo");
        }
        continue;
      }
      const type = normalizeFieldType(field.type);
      if (toInteger(raw.ac_child_field_id) !== undefined) {
        pending("campo de vínculo");
      } else if (OPTION_TYPES.has(type)) {
        const parentField = input.flowFields?.find((item) => item.id !== undefined && String(item.id) === String(parent));
        const matched = optionsByLabel(raw.options ?? field.options, rows, parentField);
        if (matched === undefined) {
          pending("opção pelo rótulo");
        } else if (matched.length > 1 && SINGLE_OPTION_TYPES.has(type)) {
          pending("opção pelo rótulo");
        } else if (matched.length > 0) {
          fill(matched, "opcao-pelo-rotulo");
        }
        // Nenhum rótulo casou: a tela deixa o campo vazio, e o obrigatório cobra.
      } else {
        const items = rows.map(({ index, value }) => ({ index, value }));
        if (DATE_TYPES.has(type)) {
          const iso = items.length === 1 ? toIsoDate(items[0]!.value) : undefined;
          // A tela descarta a data que não consegue ler (o campo fica vazio).
          if (iso) fill([{ index: 0, value: iso }], "campo-do-cartao");
        } else {
          fill(items, "campo-do-cartao");
        }
      }
    }
  }
}

/** Origem de vínculo que a tela consulta no blur (`SelectFormAnswersByRegisterService`). */
const REGISTER_PARENT_TYPES = new Set(["COMBO_BOX_REGISTER_FIELD", "COMBO_BOX_FLOW_FIELD"]);

/**
 * R3-F4: o blur da tela (`getAutoCompleteRule('answer', ..., currData)`) pede o vínculo pela origem
 * escolhida no formulário: destino com `ac_child_field_id`, origem combo de cadastro ou de cartão
 * do MESMO formulário, preenchida no que vai no mover, e destino sem valor nele.
 */
function registerRequest(
  field: NormalizedField,
  raw: Record<string, unknown>,
  parent: number,
  input: AutoCompleteInput
): RegisterAutoFill | undefined {
  const child = toInteger(raw.ac_child_field_id);
  if (child === undefined || !input.sent) return undefined;
  const parentField = input.fields.find((item) => item.id !== undefined && String(item.id) === String(parent));
  if (!parentField || !REGISTER_PARENT_TYPES.has(normalizeFieldType(parentField.type))) return undefined;
  if (field.name in input.sent || !(parentField.name in input.sent)) return undefined;
  const currValue = input.sent[parentField.name];
  if (isEmptyForField(parentField, currValue) || currValue === 0) return undefined;
  return {
    name: field.name,
    ...(field.title ? { title: field.title } : {}),
    parentFieldId: parent,
    childFieldId: child,
    currValue,
    ...(raw.options !== undefined || field.options !== undefined ? { options: raw.options ?? field.options } : {})
  };
}

/**
 * R3-F4: aplica a resposta do `POST /form/answers/by-register` (a mesma que a tela pede no blur)
 * aos pedidos de `result.byRegister`. Lista de opções: o `valueString` casado com o rótulo, sem
 * maiúscula; data: em ISO (a que não dá para ler fica vazia); o resto, o valor como veio.
 * Sem linha na resposta, o campo fica vazio e o obrigatório cobra, como na tela. `responseRaw`
 * undefined = a consulta falhou: o campo segue em `autoPending` (aviso).
 */
export function resolveByRegister(result: CarryOverResult, fields: NormalizedField[], responseRaw: unknown): void {
  if (result.byRegister.length === 0 || responseRaw === undefined) return;
  const items = toArray(Array.isArray(responseRaw) ? responseRaw : asRecord(responseRaw)?.data)
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== undefined);
  for (const request of result.byRegister) {
    const field = fields.find((item) => item.name === request.name);
    result.autoPending = result.autoPending.filter((item) => item.name !== request.name);
    if (!field) continue;
    const same = items.filter((item) => toInteger(item.field_id) === request.parentFieldId);
    const match =
      same.length > 1 ? same.find((item) => toInteger(item.child_field_id) === request.childFieldId) : same[0];
    const rows = toArray(asRecord(match?.formAnswer)?.form_answer_fields)
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => row !== undefined && !isDeleted(row));
    const type = normalizeFieldType(field.type);
    const filled: Array<{ index: number; value: string }> = [];
    for (const row of rows) {
      let value: string | undefined;
      if (OPTION_TYPES.has(type)) {
        const target = typeof row.valueString === "string" ? row.valueString.toLocaleLowerCase() : undefined;
        const option = toArray(request.options ?? field.options)
          .map(asRecord)
          .find((item) => item !== undefined && typeof item.label === "string" && item.label.toLocaleLowerCase() === target);
        value = option ? asString(option.value) : undefined;
      } else if (DATE_TYPES.has(type)) {
        const text = asString(row.value) ?? asString(row.valueString);
        value = text !== undefined && text.trim() !== "" ? toIsoDate(text) : undefined;
      } else {
        value = asString(row.value);
      }
      if (value !== undefined && value.trim() !== "") filled.push({ index: filled.length, value });
    }
    if (filled.length === 0) continue;
    const rebuilt = rebuild(field, filled);
    if (rebuilt === undefined || isEmptyForField(field, rebuilt)) {
      if (rebuilt === undefined) result.autoPending.push({ name: field.name, ...(field.title ? { title: field.title } : {}), reason: "tipo que o kit não remonta" });
      continue;
    }
    result.values[field.name] = rebuilt;
    result.autoFilled.push({ name: field.name, ...(field.title ? { title: field.title } : {}), rule: "vinculo" });
  }
  result.byRegister = [];
}

/** Linhas não excluídas com valor, na ordem do `index`. */
function valueItems(rows: unknown[]): Array<{ index: number; value: string }> {
  const items: Array<{ index: number; value: string }> = [];
  for (const item of rows) {
    const row = asRecord(item);
    if (!row || isDeleted(row)) continue;
    const value = asString(row.value);
    if (value === undefined || value.trim().length === 0) continue;
    items.push({ index: Number(row.index ?? items.length) || 0, value });
  }
  return items.sort((a, b) => a.index - b.index);
}

/**
 * Opções do campo cujo rótulo é o texto da linha de origem, sem diferenciar maiúscula
 * (`getAutoCompleteRule`: `opt.label.toLocaleLowerCase() === target.toLocaleLowerCase()`).
 * undefined = o kit não sabe o texto de alguma linha (vira pendente); [] = nada casou.
 */
function optionsByLabel(
  optionsRaw: unknown,
  rows: ParentRow[],
  parentField: NormalizedField | undefined
): Array<{ index: number; value: string }> | undefined {
  const options = toArray(optionsRaw)
    .map(asRecord)
    .filter((option): option is Record<string, unknown> => option !== undefined);
  const matched: Array<{ index: number; value: string }> = [];
  for (const row of rows) {
    const text = screenText(row, parentField);
    if (text === undefined) return undefined;
    const target = text.toLocaleLowerCase();
    const option = options.find((item) => typeof item.label === "string" && item.label.toLocaleLowerCase() === target);
    const value = option ? asString(option.value) : undefined;
    if (value !== undefined && !matched.some((item) => item.value === value)) {
      matched.push({ index: matched.length, value });
    }
  }
  return matched;
}

/**
 * O texto que a tela compara com o rótulo: o `valueString` que o back monta na linha (o
 * `GET /card` traz). Linha sem ele (a do rascunho, que a pré-resposta devolve crua): o rótulo
 * da opção pelo `field_option_id`, ou o próprio valor nos tipos em que o back copia o valor.
 */
function screenText(row: ParentRow, parentField: NormalizedField | undefined): string | undefined {
  if (typeof row.row.valueString === "string") return row.row.valueString;
  const optionId = toInteger(row.row.field_option_id);
  if (optionId !== undefined && optionId > 0) {
    const options = parentField?.options;
    if (!Array.isArray(options)) return undefined;
    const option = options.map(asRecord).find((item) => item !== undefined && toInteger(item.id_field_option) === optionId);
    // Opção que não existe mais: o back não monta o texto e a tela compara com "".
    return option ? (asString(option.label) ?? "") : "";
  }
  const fieldRecord = asRecord(row.row.field);
  const rawType = fieldRecord?.type ?? parentField?.type;
  if (typeof rawType !== "string" || rawType.trim() === "") return undefined;
  const type = normalizeFieldType(rawType);
  if (type === "NUMBER_FIELD") {
    // Percentual: o back formata ("90,00%"); o resto é o próprio valor.
    const variation = String(fieldRecord?.variation ?? parentField?.variation ?? "");
    return variation === "2" ? undefined : row.value;
  }
  return FORMATTED_TEXT_TYPES.has(type) ? undefined : row.value;
}

/**
 * Valor do campo de origem no cartão, como o `POST /form/answers/by-cards` da tela: a
 * resposta mais recente (`dt_created`) que traz o campo, rascunho da etapa incluído.
 * undefined = sem valor (a tela não preenche nada).
 */
function parentFieldRows(
  cardRaw: unknown,
  draft: Record<string, unknown> | undefined,
  parentId: number
): ParentRow[] | undefined {
  const card = findCardRecord(cardRaw);
  const answers = toArray(card?.form_answers)
    .map(asRecord)
    .filter((answer): answer is Record<string, unknown> => answer !== undefined && !isDeleted(answer));
  if (draft) answers.push(draft);
  let best: { answer: Record<string, unknown>; rows: unknown[] } | undefined;
  for (const answer of answers) {
    const rows = toArray(answer.form_answer_fields).filter((item) => {
      const row = asRecord(item);
      if (!row || isDeleted(row)) return false;
      const fieldRecord = asRecord(row.field);
      return String(firstDefined(row.field_id, row.id_field, fieldRecord?.id_field) ?? "") === String(parentId);
    });
    if (rows.length === 0) continue;
    if (!best || compareByRecencyAsc(answer, best.answer) > 0) best = { answer, rows };
  }
  if (!best) return undefined;
  const rows: ParentRow[] = [];
  for (const item of best.rows) {
    const row = asRecord(item);
    if (!row) continue;
    const value = asString(row.value);
    if (value === undefined || value.trim().length === 0) continue;
    rows.push({ index: Number(row.index ?? rows.length) || 0, value, row });
  }
  rows.sort((a, b) => a.index - b.index);
  return rows.length > 0 ? rows : undefined;
}

/** Data em ISO, como o `sanitizeAutoCompleteDateValue` da tela (ISO ou dd/MM/yyyy). */
function toIsoDate(value: string): string | undefined {
  const text = value.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(text);
  if (br) {
    const date = new Date(Date.UTC(Number(br[3]), Number(br[2]) - 1, Number(br[1])));
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function toInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

function rebuild(field: NormalizedField, items: Array<{ index: number; value: string }>, fromPreAnswer = false): unknown {
  const type = normalizeFieldType(field.type);
  const values = items.map((item) => item.value);
  if (PRE_ANSWER_ONLY_TYPES.has(type)) {
    if (!fromPreAnswer) return undefined;
    if (type === "BUTTON_FIELD") return values.length === 1 ? values[0] : undefined;
    // Anexo: 1 linha por arquivo, o valor é o id do anexo (como a tela manda de volta).
    const ids = values.map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
    return ids.length > 0 && ids.length === values.length ? ids : undefined;
  }
  if (MULTI_ID_TYPES.has(type)) {
    const ids = values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
    return ids.length === values.length ? ids : undefined;
  }
  if (MULTI_TEXT_TYPES.has(type)) return values;
  if (ITEM_LIST_TYPES.has(type)) return items.map((item) => ({ value: String(item.index), label: item.value }));
  if (values.length !== 1) return undefined;
  const [value] = values as [string];
  if (NUMBER_TYPES.has(type)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (USER_TYPES.has(type)) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }
  if (BOOLEAN_TYPES.has(type)) {
    if (value === "true" || value === "1" || value === "S") return true;
    if (value === "false" || value === "0" || value === "N") return false;
    return undefined;
  }
  if (SINGLE_TEXT_TYPES.has(type)) return value;
  return undefined;
}

function findCardRecord(raw: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(raw);
  if (!direct) return undefined;
  if (Array.isArray(direct.form_answers)) return direct;
  for (const key of ["card", "data", "item", "result", "raw"]) {
    const nested = asRecord(direct[key]);
    if (nested && Array.isArray(nested.form_answers)) return nested;
  }
  return direct;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isDeleted(record: Record<string, unknown>): boolean {
  return String(record.deleted ?? "").toUpperCase() === "S";
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Mesma ordem do back para "a resposta mais recente" (`dt_created DESC, id DESC`); sem data dos dois lados, só o id. */
function isNewer(answer: Record<string, unknown>, than: Record<string, unknown>): boolean {
  if (asString(answer.dt_created) !== undefined && asString(than.dt_created) !== undefined) {
    return compareByRecencyAsc(answer, than) > 0;
  }
  return Number(firstDefined(answer.id_form_answer, answer.id) ?? 0) > Number(firstDefined(than.id_form_answer, than.id) ?? 0);
}

function compareByRecencyAsc(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const dateA = asString(a.dt_created) ?? "";
  const dateB = asString(b.dt_created) ?? "";
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  return Number(firstDefined(a.id_form_answer, a.id) ?? 0) - Number(firstDefined(b.id_form_answer, b.id) ?? 0);
}
