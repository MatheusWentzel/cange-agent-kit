import { isDeepStrictEqual } from "node:util";

import { CangeApiError, CangeCliUsageError, CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";
import { idLikeSchema, toNumber } from "../schemas/common.js";
import {
  conditionInputSchema,
  conditionalTargetSchema,
  type ConditionInput,
  type ConditionalTarget,
  type ConditionalTargetInput
} from "../schemas/conditionals.js";
import {
  actionLabel,
  buildConditionItem,
  buildConditionalName,
  conditionInputFromItem,
  editorIssues,
  fieldIdOf,
  findFlowField,
  findFlowStep,
  itemExecution,
  parseConditionItems,
  readFlowStructure,
  resolveAction,
  summarizeCondition,
  type ConditionItem,
  type ConditionLookups,
  type ConditionSummary,
  type ConditionalKind,
  type FlowStructure,
  type RawRecord
} from "../utils/conditionalBuilder.js";

import type { CardsContracts } from "./cards.js";
import { asRecord, extractArray } from "./raw-adapters.js";
import type { RegisterQueryContracts } from "./registerQuery.js";
import type { UsersContracts } from "./users.js";

/** Body do `POST /conditional`, como a tela manda. Só este módulo o monta. */
export interface ConditionalBody {
  id_conditional?: number;
  flow_id: number;
  type: ConditionalKind;
  action: "1" | "2";
  key: number;
  field_id?: number;
  flow_step_id?: number;
  flow_step_parent_id?: number;
  conditions_items: string;
  name: string;
}

/** Regra pronta para gravar: já hidratada e validada, nada gravado ainda. */
export interface PreparedConditional {
  request: "POST /conditional";
  target: { type: ConditionalKind; description: string };
  actionLabel?: string;
  conditions: ConditionSummary[];
  /** Só em `--rehydrate`: a regra já existente que a tela executa errado (o formato foi regravado, o erro fica). */
  executionIssues?: string[];
  /** Situações em que a tela erra parte das vezes. */
  executionWarnings?: string[];
  body: ConditionalBody;
}

export interface SavedConditional {
  idConditional: number;
  name: string;
  target: { type: ConditionalKind; description: string };
  actionLabel?: string;
  conditions: ConditionSummary[];
  executionIssues?: string[];
  executionWarnings?: string[];
  /** Relida depois de gravar e igual ao que foi enviado (`false`: gravou, mas a releitura falhou). */
  verified: boolean;
  note?: string;
}

export interface ConditionalSummary {
  idConditional?: number;
  type: string;
  target: { idField?: number; idStep?: number; idStepFrom?: number; title?: string };
  action: string;
  actionLabel?: string;
  name?: string;
  index?: number;
  /** O editor da tela consegue abrir a regra (opções e valores presentes em `selectedField`). */
  opensInEditor: boolean;
  editorIssues: string[];
  /** A tela executa a regra como ela diz (nenhum `executionIssues`). */
  runsAsConfigured: boolean;
  /** Condições que nunca casam, sempre casam ou saem invertidas. */
  executionIssues: string[];
  /** Condições que erram só em parte das situações. */
  executionWarnings: string[];
  conditions: ConditionSummary[];
}

export interface ConditionalList {
  idFlow: number;
  conditionals: ConditionalSummary[];
  total: number;
  /** Quantas o editor da tela NÃO consegue abrir. */
  notOpenable: number;
  /** Quantas a tela executa errado. */
  misexecuted: number;
}

type Id = number | string;

export interface ConditionalsContracts {
  listConditionals: (input: { idFlow: Id; target?: ConditionalTargetInput }) => Promise<ConditionalList>;
  prepareConditionalCreate: (input: CreateConditionalInput) => Promise<PreparedConditional>;
  createConditional: (input: CreateConditionalInput) => Promise<SavedConditional>;
  prepareConditionalUpdate: (input: UpdateConditionalInput) => Promise<PreparedConditional>;
  updateConditional: (input: UpdateConditionalInput) => Promise<SavedConditional>;
}

export interface CreateConditionalInput {
  idFlow: Id;
  target: ConditionalTargetInput;
  action: string | number;
  conditions: ConditionInput[];
}

export interface UpdateConditionalInput {
  idFlow: Id;
  idConditional: Id;
  /** Sem ação: mantém a atual. */
  action?: string | number;
  /** Sem condições: mantém as atuais e regrava com o campo de origem inteiro. */
  conditions?: ConditionInput[];
}

function parseId(value: Id, label: string): number {
  const parsed = idLikeSchema.safeParse(value);
  if (!parsed.success || toNumber(parsed.data) <= 0) {
    throw new CangeValidationError(`${label} inválido: informe um número inteiro positivo.`, { details: { value } });
  }
  return toNumber(parsed.data);
}

function parseTarget(input: ConditionalTargetInput): ConditionalTarget {
  const parsed = conditionalTargetSchema.safeParse(input);
  if (!parsed.success) {
    throw new CangeValidationError("Alvo da condicional inválido.", { details: parsed.error.format() });
  }
  return parsed.data;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function id(value: unknown): number | undefined {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function rows(raw: unknown): RawRecord[] {
  return extractArray(raw).map(asRecord).filter((row): row is RawRecord => row !== undefined);
}

export function createConditionalsContracts(params: {
  client: CangeClient;
  users: UsersContracts;
  registerQuery: RegisterQueryContracts;
  cards: CardsContracts;
}): ConditionalsContracts {
  const { client, users, registerQuery, cards } = params;

  /** A mesma leitura do editor da tela. `withStepRules` traz também as condicionais de etapa. */
  async function loadFlow(idFlow: number, withStepRules: boolean): Promise<FlowStructure> {
    const raw = await client.get<unknown>("/flow", {
      query: { id_flow: idFlow, removeStepsCondicionals: withStepRules ? "false" : "true" }
    });
    const structure = readFlowStructure(raw);
    if (!structure) {
      throw new CangeApiError("Resposta inesperada de GET /flow (sem id_flow).", { method: "GET", endpoint: "/flow" });
    }
    return structure;
  }

  async function readByTarget(idFlow: number, target: ConditionalTarget): Promise<RawRecord[]> {
    const raw =
      target.type === "field"
        ? await client.get<unknown>("/conditional/by-field", { query: { flow_id: idFlow, field_id: target.idField } })
        : await client.get<unknown>("/conditional/by-step", {
            query: { flow_id: idFlow, flow_step_id: target.idStep, flow_step_parent_id: target.idStepFrom }
          });
    return rows(raw);
  }

  /** Todas as regras do fluxo, numa leitura só: as de campo vêm no campo, as de etapa na etapa. */
  function rulesIn(structure: FlowStructure): RawRecord[] {
    return [
      ...structure.fields.flatMap((field) => rows(field.conditionals)),
      ...structure.steps.flatMap((step) => rows(step.conditionals))
    ];
  }

  function describeTarget(structure: FlowStructure, target: ConditionalTarget): string {
    if (target.type === "field") {
      const field = findFlowField(structure, target.idField);
      if (!field) {
        throw new CangeValidationError(`O campo alvo ${target.idField} não é do fluxo ${structure.idFlow}.`);
      }
      return `campo "${text(field.title) ?? ""}" (id ${target.idField})`;
    }
    const step = findFlowStep(structure, target.idStep);
    const from = findFlowStep(structure, target.idStepFrom);
    if (!step || !from) {
      throw new CangeValidationError(
        `A etapa ${!step ? target.idStep : target.idStepFrom} não é do fluxo ${structure.idFlow}.`
      );
    }
    if (target.idStep === target.idStepFrom) {
      throw new CangeValidationError("A etapa de destino e a de origem precisam ser diferentes.");
    }
    return `etapa "${text(step.name) ?? ""}" (id ${target.idStep}), vindo de "${text(from.name) ?? ""}" (id ${target.idStepFrom})`;
  }

  function createLookups(): ConditionLookups {
    const usersCache = new Map<number, Promise<Array<{ id: number; name?: string; email?: string }>>>();
    const orMissing = async <T>(promise: Promise<T>): Promise<T | undefined> => {
      try {
        return await promise;
      } catch (error) {
        if (error instanceof CangeApiError && error.status === 404) return undefined;
        throw error;
      }
    };
    return {
      usersByForm(formId) {
        let pending = usersCache.get(formId);
        if (!pending) {
          pending = users.listUsersByForm({ formId }).then(({ raw }) =>
            rows(raw).flatMap((row) => {
              const userId = id(row.id_user ?? row.id);
              const name = text(row.name);
              const email = text(row.email);
              return userId === undefined ? [] : [{ id: userId, ...(name ? { name } : {}), ...(email ? { email } : {}) }];
            })
          );
          usersCache.set(formId, pending);
        }
        return pending;
      },
      async registerOfEntry(entryId) {
        return (await orMissing(registerQuery.locateRegisterEntry({ entryId })))?.registerId;
      },
      async flowOfCard(cardId) {
        return (await orMissing(cards.locateCard({ cardId })))?.flowId;
      }
    };
  }

  async function prepare(input: {
    structure: FlowStructure;
    target: ConditionalTarget;
    action: "1" | "2";
    conditions: ConditionInput[];
    idConditional?: number;
    key?: number;
    keepMisexecuted?: boolean;
  }): Promise<PreparedConditional> {
    const { structure, target } = input;
    const description = describeTarget(structure, target);
    if (input.conditions.length === 0) {
      throw new CangeValidationError("Informe ao menos uma condição.");
    }
    const lookups = createLookups();
    const items: ConditionItem[] = [];
    for (const [index, raw] of input.conditions.entries()) {
      const parsed = conditionInputSchema.safeParse(raw);
      if (!parsed.success) {
        throw new CangeValidationError(`Condição ${index + 1} inválida.`, { details: parsed.error.format() });
      }
      items.push(
        await buildConditionItem(structure, parsed.data, index, lookups, {
          kind: target.type,
          keepMisexecuted: input.keepMisexecuted === true
        })
      );
    }
    const label = actionLabel(target.type, input.action);
    const execution = items.map((item) => itemExecution(target.type, item));
    const issues = execution.flatMap((entry) => entry.issues);
    const warnings = execution.flatMap((entry) => entry.warnings);
    return {
      request: "POST /conditional",
      target: { type: target.type, description },
      ...(label ? { actionLabel: label } : {}),
      conditions: items.map(summarizeCondition),
      ...(issues.length > 0 ? { executionIssues: issues } : {}),
      ...(warnings.length > 0 ? { executionWarnings: warnings } : {}),
      body: {
        ...(input.idConditional !== undefined ? { id_conditional: input.idConditional } : {}),
        flow_id: structure.idFlow,
        type: target.type,
        action: input.action,
        key: input.key ?? (target.type === "field" ? target.idField : target.idStep),
        ...(target.type === "field"
          ? { field_id: target.idField }
          : { flow_step_id: target.idStep, flow_step_parent_id: target.idStepFrom }),
        conditions_items: JSON.stringify(items),
        name: buildConditionalName(items)
      }
    };
  }

  async function save(prepared: PreparedConditional): Promise<SavedConditional> {
    const { body } = prepared;
    let raw: unknown;
    try {
      raw = await client.post<unknown>("/conditional", { body });
    } catch (error) {
      if (error instanceof CangeApiError && error.status === undefined) {
        throw new CangeApiError(error.message, {
          method: "POST",
          endpoint: "/conditional",
          cause: error,
          hint: `A API não respondeu e a regra PODE ter sido gravada: confira com \`cange flow-build conditional list --id-flow ${body.flow_id}\` antes de repetir.`
        });
      }
      throw error;
    }
    const idConditional = body.id_conditional ?? id(asRecord(raw)?.id_conditional);
    if (idConditional === undefined) {
      throw new CangeApiError("POST /conditional respondeu sem id_conditional: confira com `flow-build conditional list`.", {
        method: "POST",
        endpoint: "/conditional"
      });
    }

    const result = {
      idConditional,
      name: body.name,
      target: prepared.target,
      ...(prepared.actionLabel ? { actionLabel: prepared.actionLabel } : {}),
      conditions: prepared.conditions,
      ...(prepared.executionIssues ? { executionIssues: prepared.executionIssues } : {}),
      ...(prepared.executionWarnings ? { executionWarnings: prepared.executionWarnings } : {})
    };

    // O back responde 200 no update mesmo sem achar a linha: só a releitura prova a gravação.
    let stored: RawRecord | undefined;
    try {
      const target: ConditionalTarget =
        body.type === "field"
          ? { type: "field", idField: body.field_id! }
          : { type: "step", idStep: body.flow_step_id!, idStepFrom: body.flow_step_parent_id! };
      stored = (await readByTarget(body.flow_id, target)).find((row) => id(row.id_conditional) === idConditional);
    } catch {
      return { ...result, verified: false, note: "Gravada, mas a releitura falhou: confira com `flow-build conditional list`." };
    }
    const same =
      stored !== undefined &&
      String(stored.action) === body.action &&
      isDeepStrictEqual(parseConditionItems(stored.conditions_items), JSON.parse(body.conditions_items));
    if (!same) {
      throw new CangeApiError(`A condicional ${idConditional} foi enviada, mas a releitura não bate com o que foi gravado.`, {
        method: "POST",
        endpoint: "/conditional",
        details: { idConditional, found: stored !== undefined }
      });
    }
    return { ...result, verified: true };
  }

  async function prepareConditionalCreate(input: CreateConditionalInput): Promise<PreparedConditional> {
    const idFlow = parseId(input.idFlow, "idFlow");
    const target = parseTarget(input.target);
    const action = resolveAction(target.type, input.action);
    const structure = await loadFlow(idFlow, false);
    return prepare({ structure, target, action, conditions: input.conditions });
  }

  async function prepareConditionalUpdate(input: UpdateConditionalInput): Promise<PreparedConditional> {
    const idFlow = parseId(input.idFlow, "idFlow");
    const idConditional = parseId(input.idConditional, "idConditional");
    const structure = await loadFlow(idFlow, true);
    const current = rulesIn(structure).find((rule) => id(rule.id_conditional) === idConditional);
    if (!current) {
      throw new CangeValidationError(`A condicional ${idConditional} não existe no fluxo ${idFlow}.`);
    }

    const target = targetOf(current);
    const action = resolveAction(target.type, input.action ?? String(current.action));
    let conditions = input.conditions;
    // Regravar sem mudar nada (`--rehydrate`) não piora a regra; trocar a ação de uma regra que a
    // tela executa errado muda o efeito sem o agente ver. Por isso só o primeiro passa.
    const keepMisexecuted = input.conditions === undefined && input.action === undefined;
    if (conditions === undefined) {
      const items = parseConditionItems(current.conditions_items);
      if (!items || items.length === 0) {
        throw new CangeValidationError(
          `A condicional ${idConditional} não tem condições legíveis: informe as condições com --when.`
        );
      }
      const issues = items.flatMap((item) => itemExecution(target.type, item).issues);
      if (issues.length > 0 && !keepMisexecuted) {
        throw new CangeValidationError(
          `A condicional ${idConditional} tem condição que a tela executa errado, então trocar só a ação não dá o efeito esperado. Nada foi gravado. Reescreva as condições com --when. ${issues.join(" ")}`,
          { details: { executionIssues: issues } }
        );
      }
      conditions = items.map(conditionInputFromItem);
    }
    return prepare({ structure, target, action, conditions, idConditional, key: id(current.key), keepMisexecuted });
  }

  return {
    async listConditionals(input) {
      const idFlow = parseId(input.idFlow, "idFlow");
      const target = input.target ? parseTarget(input.target) : undefined;
      const structure = await loadFlow(idFlow, target === undefined);
      if (target) describeTarget(structure, target);
      const found = target ? await readByTarget(idFlow, target) : rulesIn(structure);
      const conditionals = found.map((rule) => summarizeConditional(structure, rule));
      return {
        idFlow,
        conditionals,
        total: conditionals.length,
        notOpenable: conditionals.filter((rule) => !rule.opensInEditor).length,
        misexecuted: conditionals.filter((rule) => !rule.runsAsConfigured).length
      };
    },

    prepareConditionalCreate,
    async createConditional(input) {
      return save(await prepareConditionalCreate(input));
    },

    prepareConditionalUpdate,
    async updateConditional(input) {
      return save(await prepareConditionalUpdate(input));
    }
  };
}

function targetOf(rule: RawRecord): ConditionalTarget {
  if (rule.type === "field" && id(rule.field_id) !== undefined) {
    return { type: "field", idField: id(rule.field_id)! };
  }
  if (rule.type === "step" && id(rule.flow_step_id) !== undefined && id(rule.flow_step_parent_id) !== undefined) {
    return { type: "step", idStep: id(rule.flow_step_id)!, idStepFrom: id(rule.flow_step_parent_id)! };
  }
  throw new CangeCliUsageError(`A condicional ${String(rule.id_conditional)} não é de campo nem de etapa.`);
}

function summarizeConditional(structure: FlowStructure, rule: RawRecord): ConditionalSummary {
  const kind: ConditionalKind = rule.type === "step" ? "step" : "field";
  const items = parseConditionItems(rule.conditions_items);
  const issues = !items
    ? ["conditions_items não é uma lista JSON"]
    : items.length === 0
      ? ["conditions_items sem condições"]
      : items.flatMap(editorIssues);
  const execution = (items ?? []).map((item) => itemExecution(kind, item));
  const executionIssues = execution.flatMap((entry) => entry.issues);
  const idField = id(rule.field_id);
  const idStep = id(rule.flow_step_id);
  const idStepFrom = id(rule.flow_step_parent_id);
  const targetRecord =
    kind === "field"
      ? structure.fields.find((field) => fieldIdOf(field) === idField)
      : idStep !== undefined
        ? findFlowStep(structure, idStep)
        : undefined;
  const title = text(targetRecord?.title) ?? text(targetRecord?.name);
  const label = actionLabel(kind, rule.action);
  const name = text(rule.name);
  const idConditional = id(rule.id_conditional);
  return {
    ...(idConditional !== undefined ? { idConditional } : {}),
    type: String(rule.type),
    target: {
      ...(kind === "field" && idField !== undefined ? { idField } : {}),
      ...(kind === "step" && idStep !== undefined ? { idStep } : {}),
      ...(kind === "step" && idStepFrom !== undefined ? { idStepFrom } : {}),
      ...(title ? { title } : {})
    },
    action: String(rule.action),
    ...(label ? { actionLabel: label } : {}),
    ...(name ? { name } : {}),
    ...(typeof rule.index === "number" ? { index: rule.index } : {}),
    opensInEditor: issues.length === 0,
    editorIssues: issues,
    runsAsConfigured: executionIssues.length === 0,
    executionIssues,
    executionWarnings: execution.flatMap((entry) => entry.warnings),
    conditions: (items ?? []).map(summarizeCondition)
  };
}
