import { asRecord } from "../contracts/raw-adapters.js";
import type { NormalizedField } from "../schemas/fields.js";

import { normalizeFieldType } from "./fieldTypeGuards.js";
import { hasDescription, isEmptyForField, isRichTextType } from "./requiredFields.js";
import { hasScreenFormat, screenFormattedValue } from "./screenFormat.js";

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
 * O kit faz igual (`applyAutoComplete`): estático, data atual, criador do cartão e, com a
 * origem no cartão, o mesmo `POST /form/answers/by-cards` da tela (POP-2, revisão 4). Origem
 * vazia no cartão: a tela não preenche nada e o obrigatório cobra; o kit também (A2-F1,
 * 07/10). O que o kit não calcula (usuário atual, by-cards que falhou) vai para `autoPending`
 * e volta no aviso, obrigatório ou não.
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
 *
 * Revisão 4 do EXTRA-06 (07/10):
 *  - R4-F1 (corte estrito): a resposta confirmada criada pelo próprio movimento que trouxe o
 *    cartão para a etapa (o formulário público que o tirou da etapa anterior) cai no MESMO
 *    segundo da entrada; ela não é desta passagem. O corte agora é estrito (`>`), e no
 *    formulário gravado fora da etapa atual o corte é a saída da última passagem do cartão pela
 *    etapa dona dele (`stepExitFromMovements`), não a entrada na etapa atual.
 *  - POP-2 (autocompletar): o dinâmico com origem no cartão é o `POST /form/answers/by-cards` da
 *    tela (`byCards` + `resolveByCards`), não mais o cálculo local.
 *  - POP-1/R4-P1 (referência que a tela não resolve): o valor reenviado passa pelo que o
 *    componente da tela faz com ele (`applyScreenValue`; ver `screen-refs.ts` no CLI).
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
  /** Campos sem valor com autocompletar que o kit não calcula: vira aviso (obrigatório ou não). */
  autoPending: Array<{ name: string; title?: string; reason: string }>;
  /**
   * POP-2: destinos do autocompletar dinâmico com origem no cartão, na ordem da tela. Quem lê a
   * pré-resposta pede o `POST /form/answers/by-cards` e aplica com `resolveByCards`. Até lá o
   * campo fica em `autoPending` (aviso, não bloqueio).
   */
  byCards: CardAutoFill[];
  /**
   * POP-1/R4-P1: valores gravados que o componente da tela não resolve (usuário fora da lista,
   * cartão conectado excluído, opção que não existe, anexo que não carrega, documento sem
   * dígito). A tela mostra vazio (ou só a parte que resolve) e o mover vai igual.
   */
  unresolved: UnresolvedField[];
  /**
   * REG-F1: referências que o kit não conferiu porque o prazo das leituras acabou (anexo, usuário,
   * cartão conectado). O valor gravado fica como está, sem afirmar o que não leu: vira aviso.
   */
  unchecked?: UncheckedField[];
  /**
   * R3-F4: destinos de vínculo cuja origem vazia no cartão vem no mover. A tela preenche no
   * blur pelo `POST /form/answers/by-register`; quem lê a pré-resposta pede e aplica com
   * `resolveByRegister`. Até lá o campo fica em `autoPending` (aviso, não bloqueio).
   */
  byRegister: RegisterAutoFill[];
}

/** Valor gravado que a tela não mostra como está (POP-1/R4-P1). */
export interface UnresolvedField {
  name: string;
  title?: string;
  /** O que a tela faz com o valor (ex.: "usuário 3101 bloqueado, leitor do fluxo ou fora do fluxo privado"). */
  reason: string;
  /** Nada sobrou: a tela mostra o campo vazio. false = só parte da lista saiu. */
  emptied: boolean;
  /** Vazio na tela, mas o obrigatório da tela passa assim mesmo (o `{}` do campo de usuário). */
  passesRequired?: boolean;
}

/** Referência gravada que ficou sem conferir no prazo (REG-F1). */
export interface UncheckedField {
  name: string;
  title?: string;
  /** O que ficou sem conferir (ex.: "13 de 43 anexos"). */
  what: string;
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
   * Aplicar o autocompletar da tela (padrão: sim). Não no formulário que o mover grava fora
   * da etapa atual: a tela só autocompleta quando o cartão estiver na etapa dele.
   */
  autoComplete?: boolean;
  /**
   * R3-F1/R4-F1: o começo da passagem (ms). Na etapa atual, a entrada nela (o `dt_entry` mais
   * novo do `GET /card/moviment`); no formulário gravado fora dela, a saída da última passagem
   * pela etapa dona do formulário. Só a linha de confirmada escrita DEPOIS (estrito) disputa com
   * o rascunho. undefined = não se sabe: nenhuma confirmada disputa (a tela só lê o rascunho).
   */
  stepEntry?: number;
  /** R3-F4: o que vai no mover para este formulário (hash → valor), para o autocompletar de vínculo. */
  sent?: Record<string, unknown>;
}

/** O que o cartão tem no formulário da etapa atual, pela mesma fonte da tela (ver o topo). */
export function readStepCarryOver(input: StepCarryOverInput): CarryOverResult {
  const pre = preAnswerRecord(input.preAnswerRaw, input.formId);
  let result: CarryOverResult;
  if (!pre) {
    // Sem a rota (404): o GET /card, como antes. A rota respondeu sem nada: vazio, como a tela.
    result =
      input.preAnswerRaw === undefined
        ? readCarryOver(input.cardRaw, input.formId, input.fields)
        : build([], input.fields, "vazio");
  } else if (String(pre.origin ?? "") === SYNTHETIC_ORIGIN || firstDefined(pre.id_form_answer, pre.id) === undefined) {
    result = build([pre], input.fields, "ultima-passagem", "resposta", true);
  } else {
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

/**
 * R4-F1: a saída da última passagem do cartão pela etapa `stepId` (o `dt_exit` mais novo dos
 * movimentos dela). É o começo do que conta no formulário dessa etapa quando o mover o grava de
 * fora (o rascunho dele é o que a tela vai mostrar; a resposta da saída é da passagem anterior).
 * Sem passagem pela etapa (ou sem saída): undefined.
 */
export function stepExitFromMovements(raw: unknown, stepId: number | string): number | undefined {
  const root = asRecord(raw);
  const list = Array.isArray(raw) ? raw : toArray(root?.data ?? root?.items ?? root?.movements);
  let latest: number | undefined;
  for (const item of list) {
    const record = asRecord(item);
    if (!record) continue;
    const step = firstDefined(record.flow_step_id, asRecord(record.flow_step)?.id_step);
    if (step === undefined || String(step) !== String(stepId)) continue;
    const time = parseTime(record.dt_exit);
    if (time !== undefined && (latest === undefined || time > latest)) latest = time;
  }
  return latest;
}

/**
 * A resposta só com as linhas escritas DEPOIS de `since` (sem `since`, nenhuma). R4-F1: o corte é
 * estrito. A resposta criada pelo movimento que começou a passagem (o formulário público que
 * tirou o cartão da etapa anterior) tem o mesmo segundo da entrada e não é desta passagem
 * (cartão 1114758: o SIM da rodada anterior, gravado às 20:19:34, a entrada também).
 */
function onlyRowsSince(answer: Record<string, unknown>, since: number | undefined): Record<string, unknown> {
  if (since === undefined) return { ...answer, form_answer_fields: [] };
  const rows = toArray(answer.form_answer_fields).filter((item) => {
    const record = asRecord(item);
    if (!record) return false;
    const time = parseTime(record.dt_last_update) ?? parseTime(record.dt_created) ?? parseTime(answer.dt_created);
    return time !== undefined && time > since;
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
    byRegister: [],
    byCards: [],
    unresolved: []
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
// Autocompletar da tela (F2; POP-2 da revisão 4)
// ---------------------------------------------------------------------------

/** Destino lista de opções: a tela casa o TEXTO da origem (`valueString`) com o rótulo da opção. */
const OPTION_TYPES = new Set(["COMBO_BOX_FIELD", "RADIO_BOX_FIELD", "CHECK_BOX_FIELD", "CHECKBOX_FIELD"]);
/** Destino de data (`isDateTargetField` da tela): só recebe data que a tela consegue ler. */
const DATE_TYPES = new Set(["DATE_PICKER_FIELD", "DUE_DATE_FIELD"]);

interface AutoCompleteInput {
  /** `fields` do `GET /form/pre-answer` (com `ac_type`, `ac_parent_field_id`, `auto_complete`). */
  preFields: unknown;
  cardRaw: unknown;
  fields: NormalizedField[];
  /** R3-F4: o que vai no mover para este formulário. */
  sent?: Record<string, unknown>;
}

/** Pedido do autocompletar que a tela faz ao abrir o cartão (`POST /form/answers/by-cards`). */
export interface CardAutoFill {
  /** Campo destino (hash). */
  name: string;
  title?: string;
  /** Campo de origem (`ac_parent_field_id`). */
  parentFieldId: number;
  /** Campo do cadastro/cartão apontado (`ac_child_field_id`), no vínculo. */
  childFieldId?: number;
  /** Opções do destino (lista de opções: casa o `valueString` com o rótulo). */
  options?: unknown;
}

/**
 * Igual ao `usePreAnswer` + `getAutoCompleteRule('answer')` da tela: campo do formulário sem
 * linha no que o cartão tem recebe o valor do autocompletar dele, e esse valor vai no mover.
 *  - `ac_type = 1` (estático): as linhas de `auto_complete.form_answer_fields` (anexo também:
 *    a tela manda os ids);
 *  - `ac_type = 0` e `ac_parent_field_id`: `-1` data atual, `-3` criador do cartão; `> 0` vai
 *    para `byCards`: POP-2 (revisão 4), o kit pede ao back o MESMO `POST /form/answers/by-cards`
 *    que a tela faz ao abrir o cartão, com a mesma lista na mesma ordem (`resolveByCards`). Antes
 *    o kit calculava a origem pelo `GET /card` e o rascunho, e o vínculo com a origem preenchida,
 *    a cópia de anexo e a origem de texto formatado ficavam de fora: o campo não obrigatório
 *    sumia do mover sem aviso (cartão 433142, "Estoque Atual" e "Estoque mínimo" do cadastro).
 * Fica em `autoPending` (aviso, obrigatório ou não): `-2` usuário atual (quem abre a tela), o
 * by-cards que falhou e o tipo que o kit não remonta.
 */
function applyAutoComplete(result: CarryOverResult, input: AutoCompleteInput): void {
  const preFields = toArray(input.preFields)
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== undefined);
  if (preFields.length === 0) return;
  const byId = new Map<string, NormalizedField>();
  const byName = new Map<string, NormalizedField>();
  for (const field of input.fields) {
    if (field.id !== undefined) byId.set(String(field.id), field);
    byName.set(field.name, field);
  }

  // A ordem é a dos `fields` da pré-resposta, como a tela monta a lista do by-cards.
  for (const raw of preFields) {
    const rawId = firstDefined(raw.id_field, raw.id);
    const field = (rawId !== undefined ? byId.get(String(rawId)) : undefined) ?? (typeof raw.name === "string" ? byName.get(raw.name) : undefined);
    if (!field) continue;
    if (result.answered.has(field.name) || field.name in result.values) continue;
    const title = field.title ? { title: field.title } : {};
    const pending = (reason: string): void => {
      result.autoPending.push({ name: field.name, ...title, reason });
    };
    const fill = (items: Array<{ index: number; value: string }>, rule: AutoFillRule): void => {
      const rebuilt = rebuild(field, items, true);
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
      const child = toInteger(raw.ac_child_field_id);
      result.byCards.push({
        name: field.name,
        ...title,
        parentFieldId: parent,
        ...(child !== undefined ? { childFieldId: child } : {}),
        ...(raw.options !== undefined || field.options !== undefined ? { options: raw.options ?? field.options } : {})
      });
      // Até a resposta do by-cards: pendente (se a consulta falhar, fica o aviso).
      pending(child !== undefined ? "campo de vínculo" : "campo do cartão");
    }
  }
}

/** Itens do `POST /form/answers/by-cards` ou `by-register` (lista, ou `{ data }`). */
function responseItems(responseRaw: unknown): Array<Record<string, unknown>> {
  return toArray(Array.isArray(responseRaw) ? responseRaw : asRecord(responseRaw)?.data)
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== undefined);
}

/**
 * A resposta escolhida pela tela para a origem: a do campo de origem; com mais de uma, a do
 * campo filho do destino (ou a sem filho, quando o destino não tem vínculo).
 */
function pickAcAnswer(found: Array<Record<string, unknown>>, childFieldId: number | undefined): Record<string, unknown> | undefined {
  if (found.length === 1) return asRecord(found[0]!.formAnswer);
  if (found.length === 0) return undefined;
  const selected =
    childFieldId !== undefined
      ? found.filter((item) => toInteger(item.child_field_id) === childFieldId)
      : found.filter((item) => item.child_field_id === undefined || item.child_field_id === null);
  return selected.length > 0 ? asRecord(selected[0]!.formAnswer) : undefined;
}

/**
 * O valor que a tela põe no destino com as linhas da origem (`getAutoCompleteRule`): lista de
 * opções pelo `valueString` casado com o rótulo, sem diferenciar maiúscula; data pelo
 * `sanitizeAutoCompleteDateValue` (o `value`, senão o `valueString`; o que a tela não lê fica
 * vazio); os outros tipos copiam o `value` (ids de anexo inclusive).
 */
function acItemsFromRows(field: NormalizedField, rowsRaw: unknown, optionsRaw: unknown): Array<{ index: number; value: string }> {
  const type = normalizeFieldType(field.type);
  const rows = toArray(rowsRaw)
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== undefined && !isDeleted(row));
  const items: Array<{ index: number; value: string }> = [];
  for (const row of rows) {
    let value: string | undefined;
    if (OPTION_TYPES.has(type)) {
      // `valueString` ausente a tela compara com ""; null ela não consegue comparar (fica sem valor).
      const target = "valueString" in row ? row.valueString : "";
      if (typeof target !== "string") continue;
      const option = toArray(optionsRaw ?? field.options)
        .map(asRecord)
        .find((item) => item !== undefined && typeof item.label === "string" && item.label.toLocaleLowerCase() === target.toLocaleLowerCase());
      value = option ? asString(option.value) : undefined;
    } else if (DATE_TYPES.has(type)) {
      const rawValue = row.value !== undefined && row.value !== null && row.value !== "" ? row.value : row.valueString;
      value = sanitizeAutoCompleteDate(rawValue);
    } else {
      value = asString(row.value);
    }
    if (value !== undefined && value.trim() !== "") items.push({ index: items.length, value });
  }
  return items;
}

/** Aplica as linhas da origem no destino (o que a tela faz), ou deixa vazio. */
function fillFromAcRows(
  result: CarryOverResult,
  field: NormalizedField,
  rowsRaw: unknown,
  optionsRaw: unknown,
  rule: AutoFillRule
): void {
  const items = acItemsFromRows(field, rowsRaw, optionsRaw);
  if (items.length === 0) return;
  const title = field.title ? { title: field.title } : {};
  const rebuilt = rebuild(field, items, true);
  if (rebuilt === undefined) {
    result.autoPending.push({ name: field.name, ...title, reason: "tipo que o kit não remonta" });
    return;
  }
  if (isEmptyForField(field, rebuilt)) return;
  result.values[field.name] = rebuilt;
  result.autoFilled.push({
    name: field.name,
    ...title,
    rule: OPTION_TYPES.has(normalizeFieldType(field.type)) ? "opcao-pelo-rotulo" : rule
  });
}

/**
 * POP-2: aplica a resposta do `POST /form/answers/by-cards` (a mesma que a tela pede ao abrir o
 * cartão) aos pedidos de `result.byCards`. A origem sem linha deixa o destino vazio e o
 * obrigatório cobra, como na tela (A2-F1). `responseRaw` undefined = a consulta falhou: os
 * campos seguem em `autoPending` (aviso).
 */
export function resolveByCards(
  result: CarryOverResult,
  fields: NormalizedField[],
  responseRaw: unknown,
  ids: { cardId: number | string; flowId: number | string }
): void {
  if (result.byCards.length === 0) return;
  if (responseRaw === undefined) {
    result.byCards = [];
    return;
  }
  const cardId = toInteger(ids.cardId);
  const flowId = toInteger(ids.flowId);
  const items = responseItems(responseRaw);
  for (const request of result.byCards) {
    result.autoPending = result.autoPending.filter((item) => item.name !== request.name);
    const field = fields.find((item) => item.name === request.name);
    if (!field) continue;
    const found = items.filter(
      (item) =>
        toInteger(item.card_id) === cardId && toInteger(item.flow_id) === flowId && toInteger(item.field_id) === request.parentFieldId
    );
    const answer = pickAcAnswer(found, request.childFieldId);
    fillFromAcRows(result, field, answer?.form_answer_fields, request.options, request.childFieldId !== undefined ? "vinculo" : "campo-do-cartao");
  }
  result.byCards = [];
}

/** Origem de vínculo que a tela consulta no blur (`SelectFormAnswersByRegisterService`). */
const REGISTER_PARENT_TYPES = new Set(["COMBO_BOX_REGISTER_FIELD", "COMBO_BOX_FLOW_FIELD"]);

/**
 * R3-F4: o blur da tela (`getAutoCompleteRule('answer', ..., currData)`) pede o vínculo pela origem
 * escolhida no formulário: destino com `ac_child_field_id` que ficou vazio ao abrir o cartão (o
 * by-cards não trouxe nada), origem combo de cadastro ou de cartão do MESMO formulário,
 * preenchida no que vai no mover, e destino sem valor nele. Chamado depois do `resolveByCards`.
 */
export function requestRegisterAutoFill(
  result: CarryOverResult,
  preFieldsRaw: unknown,
  fields: NormalizedField[],
  sent: Record<string, unknown> | undefined
): void {
  if (!sent) return;
  for (const raw of toArray(preFieldsRaw).map(asRecord)) {
    if (!raw || toInteger(raw.ac_type) !== 0) continue;
    const parent = toInteger(raw.ac_parent_field_id);
    const child = toInteger(raw.ac_child_field_id);
    if (parent === undefined || parent <= 0 || child === undefined) continue;
    const rawId = firstDefined(raw.id_field, raw.id);
    const field = fields.find(
      (item) => (rawId !== undefined && item.id !== undefined && String(item.id) === String(rawId)) || (typeof raw.name === "string" && item.name === raw.name)
    );
    if (!field || result.answered.has(field.name) || field.name in result.values || field.name in sent) continue;
    if (result.autoPending.some((item) => item.name === field.name)) continue;
    const parentField = fields.find((item) => item.id !== undefined && String(item.id) === String(parent));
    if (!parentField || !REGISTER_PARENT_TYPES.has(normalizeFieldType(parentField.type)) || !(parentField.name in sent)) continue;
    const currValue = sent[parentField.name];
    if (isEmptyForField(parentField, currValue) || currValue === 0) continue;
    result.byRegister.push({
      name: field.name,
      ...(field.title ? { title: field.title } : {}),
      parentFieldId: parent,
      childFieldId: child,
      currValue,
      ...(raw.options !== undefined || field.options !== undefined ? { options: raw.options ?? field.options } : {})
    });
    result.autoPending.push({ name: field.name, ...(field.title ? { title: field.title } : {}), reason: "campo de vínculo" });
  }
}

/**
 * R3-F4: aplica a resposta do `POST /form/answers/by-register` (a mesma que a tela pede no blur)
 * aos pedidos de `result.byRegister`, com o mesmo mapeamento do by-cards. Sem linha na resposta,
 * o campo fica vazio e o obrigatório cobra, como na tela. `responseRaw` undefined = a consulta
 * falhou: o campo segue em `autoPending` (aviso).
 */
export function resolveByRegister(result: CarryOverResult, fields: NormalizedField[], responseRaw: unknown): void {
  if (result.byRegister.length === 0 || responseRaw === undefined) return;
  const items = responseItems(responseRaw);
  for (const request of result.byRegister) {
    const field = fields.find((item) => item.name === request.name);
    result.autoPending = result.autoPending.filter((item) => item.name !== request.name);
    if (!field) continue;
    const same = items.filter((item) => toInteger(item.field_id) === request.parentFieldId);
    const match =
      same.length > 1 ? same.find((item) => toInteger(item.child_field_id) === request.childFieldId) : same[0];
    fillFromAcRows(result, field, asRecord(match?.formAnswer)?.form_answer_fields, request.options, "vinculo");
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
 * `sanitizeAutoCompleteDateValue` da tela (`parseImportedDate`): ISO com fuso preserva o instante;
 * `aaaa-mm-dd`, `aaaa/mm/dd` e `dd/mm/aaaa` (ano de 2 dígitos na janela 1970-2069, hora opcional)
 * viram hora LOCAL; o resto (texto, 31/02) fica vazio.
 */
export function sanitizeAutoCompleteDate(raw: unknown): string | undefined {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    const parsed = new Date(Date.UTC(1899, 11, 30) + Math.round(raw * 86400000));
    if (Number.isNaN(parsed.getTime())) return undefined;
    return new Date(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()).toISOString();
  }
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text === "") return undefined;
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  const [datePart = "", ...rest] = text.split(/[\sT]+/);
  let year: number;
  let month: number;
  let day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(datePart) ?? /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(datePart);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(datePart);
    if (!dmy) return undefined;
    day = Number(dmy[1]);
    month = Number(dmy[2]);
    const shortYear = Number(dmy[3]);
    year = shortYear >= 100 ? shortYear : shortYear < 70 ? 2000 + shortYear : 1900 + shortYear;
  }
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return undefined;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(rest[0] ?? "");
  if (time) {
    const [h, m, sec] = [Number(time[1]), Number(time[2]), time[3] !== undefined ? Number(time[3]) : 0];
    if (h <= 23 && m <= 59 && sec <= 59) {
      hours = h;
      minutes = m;
      seconds = sec;
    }
  }
  return new Date(year, month - 1, day, hours, minutes, seconds).toISOString();
}

// ---------------------------------------------------------------------------
// O que o componente da tela faz com o valor gravado (POP-1, R4-P1)
// ---------------------------------------------------------------------------

/**
 * POP-1/R4-P1: troca o valor que o mover reenviaria pelo que o componente da tela entrega
 * (`next`; undefined ou vazio = a tela mostra o campo vazio) e registra o motivo. Vazio sai do
 * `values` e do `stored` (a tela não manda) e do `filled` (o obrigatório cobra), salvo
 * `passesRequired` (o `{}` do campo de usuário que o obrigatório da tela aceita).
 */
export function applyScreenValue(
  result: CarryOverResult,
  field: NormalizedField,
  next: unknown,
  reason: string,
  passesRequired = false
): void {
  const title = field.title ? { title: field.title } : {};
  const emptied = next === undefined || isEmptyForField(field, next);
  if (emptied) {
    delete result.values[field.name];
    result.stored.delete(field.name);
    if (!passesRequired) result.filled.delete(field.name);
  } else {
    result.values[field.name] = next;
  }
  result.autoFilled = emptied ? result.autoFilled.filter((item) => item.name !== field.name) : result.autoFilled;
  result.unresolved = result.unresolved.filter((item) => item.name !== field.name);
  result.unresolved.push({ name: field.name, ...title, reason, emptied, ...(emptied && passesRequired ? { passesRequired: true } : {}) });
}

/** Opções do campo como a tela as tem (as da pré-resposta, senão as do `GET /field/by-flow`). */
function screenOptions(field: NormalizedField, preFields: unknown): Array<Record<string, unknown>> {
  const raw = toArray(preFields)
    .map(asRecord)
    .find((item) => item !== undefined && field.id !== undefined && String(firstDefined(item.id_field, item.id)) === String(field.id));
  return toArray(raw?.options ?? field.options)
    .map(asRecord)
    .filter((option): option is Record<string, unknown> => option !== undefined);
}

function isHiddenOption(option: Record<string, unknown>): boolean {
  return String(option.hide ?? "").toUpperCase() === "S";
}

/**
 * POP-1/R4-P1, a parte sem rede: o que os componentes da tela fazem com o valor gravado.
 *  - combo (`ComboBox`): só o valor que existe nas opções (a oculta vale); "none" (o
 *    "Selecione aqui..." gravado) e a opção apagada a tela mostra vazios;
 *  - rádio e caixa de marcação: só a opção visível (a tela não monta a oculta);
 *  - check list: o item sem descrição a tela descarta (também na conta do obrigatório);
 *  - documento e telefone: a máscara que não deixa nada vira vazio.
 */
export function resolveLocalScreenValues(result: CarryOverResult, fields: NormalizedField[], preFields?: unknown): void {
  for (const field of fields) {
    if (!(field.name in result.values)) continue;
    const value = result.values[field.name];
    const type = normalizeFieldType(field.type);
    if (type === "COMBO_BOX_FIELD") {
      if (typeof value !== "string" && typeof value !== "number") continue;
      const options = screenOptions(field, preFields);
      if (options.length === 0 || options.some((option) => String(option.value) === String(value))) continue;
      applyScreenValue(
        result,
        field,
        undefined,
        String(value) === "none" ? 'gravado "none", o "Selecione aqui..." do combo' : `opção "${String(value)}" que não existe mais no campo`
      );
    } else if (type === "RADIO_BOX_FIELD") {
      if (typeof value !== "string" && typeof value !== "number") continue;
      const options = screenOptions(field, preFields);
      if (options.length === 0) continue;
      if (options.some((option) => !isHiddenOption(option) && String(option.value) === String(value))) continue;
      const hidden = options.some((option) => String(option.value) === String(value));
      applyScreenValue(result, field, undefined, `opção "${String(value)}" ${hidden ? "oculta" : "que não existe mais no campo"}`);
    } else if (type === "CHECK_BOX_FIELD" || type === "CHECKBOX_FIELD") {
      if (!Array.isArray(value)) continue;
      const options = screenOptions(field, preFields);
      if (options.length === 0) continue;
      const visible = new Set(options.filter((option) => !isHiddenOption(option)).map((option) => String(option.value)));
      const kept = value.filter((item) => visible.has(String(item)));
      if (kept.length === value.length) continue;
      const dropped = value.filter((item) => !visible.has(String(item))).map(String);
      applyScreenValue(result, field, kept, `opção ${dropped.map((item) => `"${item}"`).join(", ")} oculta ou que não existe mais`);
    } else if (type === "CHECK_LIST_FIELD") {
      if (!Array.isArray(value)) continue;
      const kept = value.filter((item) => hasDescription(item));
      if (kept.length === value.length) continue;
      applyScreenValue(result, field, kept, `${value.length - kept.length} item(ns) sem descrição (a tela descarta)`);
    } else if (hasScreenFormat(type)) {
      if (typeof value !== "string") continue;
      if (screenFormattedValue(type, field.variation ?? field.raw?.variation, value).trim() !== "") continue;
      applyScreenValue(result, field, undefined, `"${value}" não tem os dígitos que o campo mostra`);
    }
  }
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
