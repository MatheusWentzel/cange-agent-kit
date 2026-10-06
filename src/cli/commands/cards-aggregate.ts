import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import type { FlowAggregationItem } from "../../contracts/flowQuery.js";
import { extractFlowSteps } from "../../contracts/payload-builder.js";
import { asRecord, extractArray } from "../../contracts/raw-adapters.js";
import type { CangeAgentKit } from "../../index.js";
import type { NormalizedField } from "../../schemas/fields.js";
import { dropEmpty } from "../../utils/lean.js";
import { listOutput } from "../../utils/toon.js";
import { listFieldTitles, matchFieldsByKey, normalizeText, parseLocaleNumber } from "../../utils/valueResolver.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { envFlowId } from "../env-defaults.js";

/**
 * C4 (card #1367459): CONTAR e SOMAR no kit. Em produção, "calcular com os dados lidos"
 * (python/jq sobre a saída do `card list`) era 7% do custo e aparecia em quase toda
 * tarefa de contagem/soma: o agente baixava a lista inteira, relia no contexto e
 * ainda escrevia o script. Aqui a resposta já sai pronta: `{total, groups}`.
 *
 * Fonte dos números (sempre só cartões ATIVOS: não arquivados nem excluídos, e só os
 * que o token enxerga, porque tudo passa pela API com o acesso dele):
 *  - motor V2, sem `--where` e agrupando por etapa (ou sem agrupar): o próprio back
 *    agrega (`POST /flow/v2/aggregations`, o mesmo do cabeçalho do Kanban). 1 chamada
 *    (soma por etapa: 1 por etapa).
 *  - o resto (filtro por campo, agrupar por campo, motor V1 ou falha do agregador):
 *    lê os cartões paginados (V2 com só os campos necessários; V1 `/card/by-flow`) e
 *    agrega aqui.
 */

interface AggregateOptions {
  flowId?: string;
  by?: string;
  where?: string[];
  field?: string;
}

type GroupBy = { kind: "none" } | { kind: "step" } | { kind: "field"; field: NormalizedField };

interface WhereClause {
  negate: boolean;
  wanted: string;
  target: { kind: "step" } | { kind: "field"; field: NormalizedField };
}

interface StepInfo {
  id: string;
  name: string;
  index: number;
}

/** Um cartão como o agregador precisa: etapa e os valores dos campos pedidos. */
interface CardRow {
  stepId: string;
  /** fieldId → valores exibidos (multi-valor = vários). */
  texts: Map<string, string[]>;
  /** fieldId → número (quando o campo tem número). */
  numbers: Map<string, number>;
}

/** Teto da leitura paginada: 40 páginas de 500 = 20 mil cartões. */
const PAGE_SIZE = 500;
const MAX_PAGES = 40;
const EMPTY_KEY = "(vazio)";
const STEP_WORDS = new Set(["etapa", "step", "etapas"]);

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerCardsAggregateCommands(parent: Command): void {
  const count = parent
    .command("count")
    .description(
      "CONTA cartões ativos de um fluxo (não arquivados nem excluídos), no total, por etapa ou por valor de campo. Use no lugar de listar e contar com python"
    )
    .option("--flow-id <id>", "ID do fluxo (link do Cange também serve; no run, o fluxo do cartão é o padrão)")
    .option("--by <grupo>", 'Agrupa: etapa | campo:"<título do campo>"')
    .option(
      "--where <filtro>",
      'Filtro "<campo>=<valor>" ou "<campo>!=<valor>" (repetível, todos valem). Campo pelo título, id ou hash; "etapa=<nome ou id>" filtra pela etapa',
      collect
    )
    .action(
      createCommandAction(async ({ kit }, options: AggregateOptions) => {
        const out = await aggregate(kit, options, "count");
        return listOutput(out, "groups");
      })
    );
  annotateCommand(count, {
    envelope: "{ total, groups?: [{key, stepId?, count}], truncated? } (groups só com --by; grupo sem cartão não aparece)",
    fieldsLocation: "`total` é o número de cartões que casam; com --by, um item por etapa ou por valor do campo",
    example: 'cards count --flow-id 192 --by etapa --where "Prioridade=Alta"'
  });

  const sum = parent
    .command("sum")
    .description("SOMA um campo numérico (número, moeda, fórmula) nos cartões ativos de um fluxo, no total ou por grupo")
    .option("--flow-id <id>", "ID do fluxo (link do Cange também serve; no run, o fluxo do cartão é o padrão)")
    .option("--field <campo>", "Campo numérico a somar: título, id ou hash")
    .option("--by <grupo>", 'Agrupa: etapa | campo:"<título do campo>"')
    .option("--where <filtro>", 'Filtro "<campo>=<valor>" ou "<campo>!=<valor>" (repetível)', collect)
    .action(
      createCommandAction(async ({ kit }, options: AggregateOptions) => {
        const out = await aggregate(kit, options, "sum");
        return listOutput(out, "groups");
      })
    );
  annotateCommand(sum, {
    envelope:
      "{ total, cards, groups?: [{key, stepId?, sum}], ignored?, truncated? } (total = soma; cards = cartões que casam; ignored = cartões com valor que não é número)",
    fieldsLocation: "`total` é a soma do campo; com --by, a soma de cada grupo",
    example: 'cards sum --flow-id 192 --field "Valor do Negócio" --by etapa'
  });
}

async function aggregate(
  kit: CangeAgentKit,
  options: AggregateOptions,
  mode: "count" | "sum"
): Promise<Record<string, unknown>> {
  const flowId = options.flowId ?? envFlowId();
  if (!flowId) {
    throw new CangeCliUsageError("--flow-id é obrigatório (o link do fluxo ou do cartão também serve).");
  }
  if (mode === "sum" && !options.field) {
    throw new CangeCliUsageError('Informe o campo a somar: --field "<título do campo>".');
  }

  const steps = await loadSteps(kit, flowId);
  const needsFields =
    mode === "sum" ||
    (options.by !== undefined && !STEP_WORDS.has(stripByPrefix(options.by).toLowerCase())) ||
    (options.where ?? []).some((clause) => !STEP_WORDS.has(splitWhere(clause).key.toLowerCase()));
  const fields = needsFields ? (await kit.contracts.getFieldsByFlow({ flowId })).fields : [];

  const groupBy = parseBy(options.by, fields, flowId);
  const where = (options.where ?? []).map((clause) => parseWhere(clause, fields, flowId));
  const sumField = mode === "sum" ? resolveOne(options.field!, fields, flowId) : undefined;

  const engine = await kit.contracts.resolveQueryEngine(flowId);
  if (engine === "v2" && where.length === 0 && groupBy.kind !== "field") {
    try {
      return await aggregateOnServer(kit, flowId, steps, groupBy, mode, sumField);
    } catch {
      // Agregador indisponível ou recusou: segue pela leitura paginada (mesmo resultado, mais lento).
    }
  }

  const needed = new Map<string, NormalizedField>();
  for (const field of [
    ...(groupBy.kind === "field" ? [groupBy.field] : []),
    ...where.flatMap((clause) => (clause.target.kind === "field" ? [clause.target.field] : [])),
    ...(sumField ? [sumField] : [])
  ]) {
    needed.set(String(field.id), field);
  }

  const { rows, truncated } =
    engine === "v2"
      ? await readRowsV2(kit, flowId, [...needed.values()]).catch(() => readRowsV1(kit, flowId))
      : await readRowsV1(kit, flowId);

  const stepById = new Map(steps.map((step) => [step.id, step]));
  const matching = rows.filter((row) => where.every((clause) => matches(row, clause, stepById)));
  return aggregateRows(matching, groupBy, mode, sumField, steps, truncated);
}

// ---------------------------------------------------------------------------
// Parâmetros
// ---------------------------------------------------------------------------

function stripByPrefix(by: string): string {
  return by.trim().replace(/^(campo|field)\s*:\s*/i, "").replace(/^"(.*)"$/, "$1").trim();
}

function parseBy(by: string | undefined, fields: NormalizedField[], flowId: string): GroupBy {
  if (by === undefined || by.trim() === "") return { kind: "none" };
  const key = stripByPrefix(by);
  if (STEP_WORDS.has(key.toLowerCase())) return { kind: "step" };
  return { kind: "field", field: resolveOne(key, fields, flowId) };
}

function splitWhere(clause: string): { key: string; negate: boolean; value: string } {
  const neq = clause.indexOf("!=");
  const eq = clause.indexOf("=");
  if (eq <= 0) {
    throw new CangeCliUsageError(`--where "${clause}" inválido: use "<campo>=<valor>" ou "<campo>!=<valor>".`);
  }
  const negate = neq > 0 && neq === eq - 1;
  const key = clause.slice(0, negate ? neq : eq).trim().replace(/^"(.*)"$/, "$1");
  const value = clause.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
  return { key, negate, value };
}

function parseWhere(clause: string, fields: NormalizedField[], flowId: string): WhereClause {
  const { key, negate, value } = splitWhere(clause);
  if (STEP_WORDS.has(key.toLowerCase())) {
    return { negate, wanted: value, target: { kind: "step" } };
  }
  return { negate, wanted: value, target: { kind: "field", field: resolveOne(key, fields, flowId) } };
}

/** Campo pelo título, id ou hash (a mesma resolução das escritas); 0 ou 2+ = erro de uso. */
function resolveOne(key: string, fields: NormalizedField[], flowId: string): NormalizedField {
  const hits = matchFieldsByKey(key, fields);
  if (hits.length === 0) {
    throw new CangeCliUsageError(`Campo "${key}" não existe no fluxo ${flowId} (campos: ${listFieldTitles(fields)}).`);
  }
  if (hits.length > 1) {
    throw new CangeCliUsageError(
      `"${key}" casa com ${hits.length} campos: ${hits
        .map((field) => `${field.title ?? field.name} (id ${field.id ?? field.name})`)
        .join(", ")}. Use o id.`
    );
  }
  return hits[0]!;
}

async function loadSteps(kit: CangeAgentKit, flowId: string): Promise<StepInfo[]> {
  const flow = await kit.contracts.getFlow({ idFlow: flowId });
  return extractFlowSteps(flow.raw)
    .filter((step) => step.id !== undefined)
    .map((step, position) => ({
      id: String(step.id),
      name: step.name ?? `Etapa ${step.id}`,
      index: step.index !== undefined ? Number(step.index) : position
    }))
    .sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Agregação no servidor (V2)
// ---------------------------------------------------------------------------

async function aggregateOnServer(
  kit: CangeAgentKit,
  flowId: string,
  steps: StepInfo[],
  groupBy: GroupBy,
  mode: "count" | "sum",
  sumField: NormalizedField | undefined
): Promise<Record<string, unknown>> {
  if (mode === "count") {
    const result = await kit.contracts.aggregateFlowV2({
      flowId,
      agg: [{ fn: "COUNT", target: "card", key: "", by_step: true }]
    });
    const counts = result.stepCounts;
    if (!counts) throw new Error("agregador sem step_counts");
    // A soma por etapa é exata (o COUNT do conjunto para em 10 mil cartões).
    const total = Object.values(counts).reduce((acc, n) => acc + n, 0);
    const groups =
      groupBy.kind === "step"
        ? stepGroups(steps, (step) => counts[step.id] ?? 0).map(({ step, value }) => ({
            key: step.name,
            stepId: Number(step.id),
            count: value
          }))
        : undefined;
    return dropEmpty({ total, groups });
  }

  const key = String(sumField!.id);
  const agg: FlowAggregationItem[] = [
    { fn: "SUM", target: "field", key },
    { fn: "COUNT", target: "card", key: "" }
  ];
  if (groupBy.kind === "step") {
    let truncated = false;
    let total = 0;
    let cards = 0;
    const perStep: Array<{ key: string; stepId: number; sum: number }> = [];
    for (const step of steps) {
      const result = await kit.contracts.aggregateFlowV2({ flowId, flowStepId: step.id, agg });
      truncated ||= result.truncated;
      const stepCards = result.filteredScope["COUNT:card:"] ?? 0;
      const stepSum = result.filteredScope[`SUM:field:${key}`] ?? 0;
      cards += stepCards;
      total += stepSum;
      if (stepCards > 0) perStep.push({ key: step.name, stepId: Number(step.id), sum: round(stepSum) });
    }
    return dropEmpty({ total: round(total), cards, groups: perStep, truncated: truncated || undefined });
  }
  const result = await kit.contracts.aggregateFlowV2({ flowId, agg });
  return dropEmpty({
    total: round(result.filteredScope[`SUM:field:${key}`] ?? 0),
    cards: result.filteredScope["COUNT:card:"] ?? 0,
    truncated: result.truncated || undefined
  });
}

function stepGroups(steps: StepInfo[], valueOf: (step: StepInfo) => number): Array<{ step: StepInfo; value: number }> {
  return steps.map((step) => ({ step, value: valueOf(step) })).filter((item) => item.value > 0);
}

// ---------------------------------------------------------------------------
// Leitura paginada + agregação aqui
// ---------------------------------------------------------------------------

async function readRowsV2(
  kit: CangeAgentKit,
  flowId: string,
  fields: NormalizedField[]
): Promise<{ rows: CardRow[]; truncated: boolean }> {
  const fieldView = fields
    .filter((field) => field.id !== undefined && field.formId !== undefined)
    .map((field, index) => ({
      id_field: Number(field.id),
      form_id: Number(field.formId),
      type: field.type,
      title: field.title ?? field.name,
      active: true,
      index,
      indexOrigin: index,
      origin: "field",
      reordered: false
    }));
  const rows: CardRow[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await kit.contracts.queryFlowV2({
      flowId,
      ...(fieldView.length > 0 ? { fields: fieldView } : {}),
      isArchived: false,
      pageSize: PAGE_SIZE,
      ...(cursor ? { cursor } : {})
    });
    for (const item of extractArray(asRecord(page.raw)?.items ?? page.raw)) {
      rows.push(rowFromV2Item(item));
    }
    pages += 1;
    cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : undefined;
  } while (cursor && pages < MAX_PAGES);
  return { rows, truncated: Boolean(cursor) };
}

function rowFromV2Item(item: unknown): CardRow {
  const record = asRecord(item) ?? {};
  const card = asRecord(record.card) ?? record;
  const row: CardRow = {
    stepId: String(card.flow_step_id ?? card.step_id ?? ""),
    texts: new Map(),
    numbers: new Map()
  };
  for (const [key, raw] of Object.entries(asRecord(record.fields) ?? {})) {
    if (!key.startsWith("field:")) continue;
    const fieldId = key.slice("field:".length);
    const value = asRecord(raw) ?? {};
    const mvCount = Number(value.mvCount ?? 0);
    const text = firstText(value, ["valueString", "value"]);
    const multi = typeof value.mvDisplayValue === "string" && mvCount > 1 ? splitMulti(value.mvDisplayValue) : undefined;
    const texts = multi ?? (text !== undefined ? [text] : []);
    if (texts.length > 0) row.texts.set(fieldId, texts);
    const number = typeof value.valueNumber === "number" ? value.valueNumber : numberFrom(firstText(value, ["value", "valueString"]));
    if (number !== undefined) row.numbers.set(fieldId, number);
  }
  return row;
}

async function readRowsV1(kit: CangeAgentKit, flowId: string): Promise<{ rows: CardRow[]; truncated: boolean }> {
  const result = await kit.contracts.listCardsByFlow({ flowId, isArchived: false });
  const rows: CardRow[] = [];
  for (const item of extractArray(result.raw)) {
    const card = asRecord(item);
    if (!card) continue;
    if (card.archived === true || card.archived === "S" || card.deleted === "S") continue;
    const row: CardRow = {
      stepId: String(card.flow_step_id ?? card.step_id ?? asRecord(card.flow_step)?.id_step ?? ""),
      texts: new Map(),
      numbers: new Map()
    };
    for (const answer of toRecords(card.form_answers)) {
      if (answer.deleted === "S") continue;
      for (const answerField of toRecords(answer.form_answer_fields)) {
        if (answerField.deleted === "S") continue;
        const fieldId = answerField.field_id ?? answerField.id_field ?? asRecord(answerField.field)?.id_field;
        if (fieldId === undefined || fieldId === null) continue;
        const key = String(fieldId);
        const text = firstText(answerField, ["valueString", "value_string", "value"]);
        if (text !== undefined) row.texts.set(key, [...(row.texts.get(key) ?? []), text]);
        const number = numberFrom(firstText(answerField, ["value", "valueString"]));
        if (number !== undefined && !row.numbers.has(key)) row.numbers.set(key, number);
      }
    }
    rows.push(row);
  }
  return { rows, truncated: false };
}

function matches(row: CardRow, clause: WhereClause, stepById: Map<string, StepInfo>): boolean {
  const wanted = normalizeText(clause.wanted);
  let hit: boolean;
  if (clause.target.kind === "step") {
    const step = stepById.get(row.stepId);
    hit = row.stepId === clause.wanted.trim() || (step !== undefined && normalizeText(step.name) === wanted);
  } else {
    const fieldId = String(clause.target.field.id);
    const texts = row.texts.get(fieldId) ?? [];
    const wantedNumber = numberFrom(clause.wanted);
    const number = row.numbers.get(fieldId);
    hit =
      (wanted === "" || wanted === normalizeText(EMPTY_KEY) ? texts.length === 0 : false) ||
      texts.some((text) => normalizeText(text) === wanted) ||
      (wantedNumber !== undefined && number !== undefined && wantedNumber === number);
  }
  return clause.negate ? !hit : hit;
}

function aggregateRows(
  rows: CardRow[],
  groupBy: GroupBy,
  mode: "count" | "sum",
  sumField: NormalizedField | undefined,
  steps: StepInfo[],
  truncated: boolean
): Record<string, unknown> {
  const sumKey = sumField ? String(sumField.id) : undefined;
  let ignored = 0;
  const valueOf = (row: CardRow): number => {
    if (!sumKey) return 1;
    const number = row.numbers.get(sumKey);
    if (number === undefined) {
      if ((row.texts.get(sumKey) ?? []).length > 0) ignored += 1;
      return 0;
    }
    return number;
  };

  const groups = new Map<string, { key: string; stepId?: number; count: number; sum: number }>();
  let total = 0;
  for (const row of rows) {
    const value = valueOf(row);
    total += value;
    if (groupBy.kind === "none") continue;
    const keys =
      groupBy.kind === "step"
        ? [row.stepId]
        : (() => {
            const texts = row.texts.get(String(groupBy.field.id)) ?? [];
            return texts.length > 0 ? Array.from(new Set(texts)) : [EMPTY_KEY];
          })();
    for (const key of keys) {
      const group = groups.get(key) ?? { key, count: 0, sum: 0 };
      group.count += 1;
      group.sum += value;
      groups.set(key, group);
    }
  }

  let list: Array<{ key: string; stepId?: number; count: number; sum: number }> | undefined;
  if (groupBy.kind === "step") {
    list = steps
      .filter((step) => groups.has(step.id))
      .map((step) => ({ ...groups.get(step.id)!, key: step.name, stepId: Number(step.id) }));
    // Cartão numa etapa que o fluxo não lista (dado antigo): entra com o id.
    for (const [stepId, group] of groups) {
      if (!steps.some((step) => step.id === stepId)) list.push({ ...group, key: stepId || EMPTY_KEY });
    }
  } else if (groupBy.kind === "field") {
    list = [...groups.values()].sort((a, b) =>
      mode === "count" ? b.count - a.count : b.sum - a.sum
    );
  }

  if (mode === "count") {
    return dropEmpty({
      total: rows.length,
      groups: list?.map((group) => ({ key: group.key, stepId: group.stepId, count: group.count })),
      truncated: truncated || undefined
    });
  }
  return dropEmpty({
    total: round(total),
    cards: rows.length,
    groups: list?.map((group) => ({ key: group.key, stepId: group.stepId, sum: round(group.sum) })),
    ignored: ignored > 0 ? ignored : undefined,
    truncated: truncated || undefined
  });
}

// ---------------------------------------------------------------------------
// Pequenos
// ---------------------------------------------------------------------------

/** Tira o ruído de ponto flutuante (0.1 + 0.2) sem arredondar centavo nem fração. */
function round(value: number): number {
  return Number(value.toFixed(6));
}

function numberFrom(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const parsed = parseLocaleNumber(text);
  return parsed.ok ? parsed.value : undefined;
}

function splitMulti(text: string): string[] {
  return text
    .split(/\s*[,;]\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function firstText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function toRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined)
    : [];
}
