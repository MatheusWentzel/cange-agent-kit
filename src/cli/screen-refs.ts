import { CangeApiError } from "../client/errors.js";
import { asRecord, extractArray } from "../contracts/raw-adapters.js";
import type { CangeAgentKit } from "../index.js";
import type { NormalizedField } from "../schemas/fields.js";
import { applyScreenValue, resolveLocalScreenValues, type CarryOverResult } from "../utils/carryOver.js";
import { normalizeFieldType } from "../utils/fieldTypeGuards.js";
import { isRequiredOnScreen } from "../utils/requiredFields.js";
import { SCREEN_USER_TYPES } from "../utils/valueResolver.js";

import { screenUsersFor } from "./write-support.js";

/**
 * POP-1 e R4-P1 (revisão 4 do EXTRA-06, 07/10): referência gravada que a tela não resolve.
 *
 * O kit contava e reenviava o valor CRU da fonte da tela, mas o componente da tela resolve a
 * referência antes de mostrar e, sem achar, mostra vazio, manda vazio e o obrigatório recusa:
 *  - usuário (`ComboBoxUser`): só o id da lista do campo (`GET /user/by-flow?form_id` sem o
 *    leitor; variation "2" pela empresa). Bloqueado, leitor ou fora do fluxo privado fica de fora
 *    (cartão 311243: "Cotação 1 - Aprovador" = 3101, bloqueado; 824006 e 886823 do R4-P1);
 *  - cartão conectado (`ComboBoxFlow`): só o que o `POST /card/by-cards` devolve (cartão
 *    excluído não volta; 675472);
 *  - anexo (`InputAttach`): cada id pelo `GET /attachment`; um que não carrega (404) e a tela
 *    não mostra nenhum (o laço dela para no erro);
 *  - combo, rádio, caixa de marcação, check list, documento e telefone: `resolveLocalScreenValues`.
 * O que sobra vazio sai do mover e do preenchido (o obrigatório cobra com motivo próprio); o não
 * obrigatório sai do mover, como a tela, e volta no aviso. Falha de leitura (rede, 5xx) não muda
 * nada: o kit não afirma o que não conferiu.
 */
export interface ScreenRefsInput {
  carry: CarryOverResult;
  fields: NormalizedField[];
  /** `fields` da pré-resposta (as opções que a tela usa). */
  preFields?: unknown;
  /** Fluxo do cartão (o pai do campo de cartão conectado). */
  flowId?: number | string;
}

export async function resolveScreenReferences(kit: CangeAgentKit, input: ScreenRefsInput): Promise<void> {
  const { carry, fields } = input;
  resolveLocalScreenValues(carry, fields, input.preFields);
  const userLists = new Map<string, Promise<ReadonlySet<number> | undefined>>();
  await Promise.all(
    fields.map(async (field) => {
      if (!(field.name in carry.values)) return;
      const type = normalizeFieldType(field.type);
      const value = carry.values[field.name];
      if (SCREEN_USER_TYPES.has(type)) {
        if (typeof value !== "number") return;
        const allowed = await screenUsersFor(kit, field, userLists);
        if (!allowed || allowed.has(value)) return;
        applyScreenValue(
          carry,
          field,
          undefined,
          `usuário ${value} bloqueado, leitor do fluxo ou fora do fluxo privado; a tela não o lista`,
          !userEmptyBlocks(field)
        );
      } else if (type === "COMBO_BOX_FLOW_FIELD") {
        await resolveConnectedCards(kit, carry, field, value, input.flowId);
      } else if (type === "INPUT_ATTACH_FIELD") {
        await resolveAttachments(kit, carry, field, value);
      }
    })
  );
}

/**
 * O campo de usuário vazio (o `getValue` devolve `{}`) só é recusado pela tela no `matches` que o
 * `createYupSchema` põe quando a 1ª regra gravada do campo de usuário é a `required`. Sem isso o
 * `required` do yup aceita o `{}` (vira "[object Object]") e a tela move com o campo vazio.
 */
function userEmptyBlocks(field: NormalizedField): boolean {
  if (normalizeFieldType(field.type) !== "COMBO_BOX_USER_FIELD" || !isRequiredOnScreen(field)) return false;
  const rules = field.raw?.validations;
  if (!Array.isArray(rules) || rules.length === 0) return false;
  const first = asRecord(rules[0]);
  return String(first?.type ?? "").toLowerCase() === "required" && Number(first?.field_id ?? 0) > 0;
}

async function resolveConnectedCards(
  kit: CangeAgentKit,
  carry: CarryOverResult,
  field: NormalizedField,
  value: unknown,
  parentFlowId: number | string | undefined
): Promise<void> {
  if (!Array.isArray(value) || value.length === 0) return;
  const linkedFlow = field.raw?.flow_id;
  if (linkedFlow === undefined || linkedFlow === null || String(linkedFlow).trim() === "") return;
  let response: unknown;
  try {
    response = await kit.contracts.getCardsByIds({
      flowId: String(linkedFlow),
      ...(parentFlowId !== undefined ? { parentFlowId } : {}),
      cardIds: value.map((item) => String(item))
    });
  } catch {
    return;
  }
  const found = new Set(
    extractArray(response)
      .map(asRecord)
      .map((card) => (card ? String(card.id_card ?? card.id ?? "") : ""))
      .filter((id) => id !== "")
  );
  const kept = value.filter((item) => found.has(String(item)));
  if (kept.length === value.length) return;
  const dropped = value.filter((item) => !found.has(String(item))).map(String);
  applyScreenValue(carry, field, kept, `cartão ${dropped.join(", ")} excluído ou sem acesso; a tela não o carrega`);
}

async function resolveAttachments(kit: CangeAgentKit, carry: CarryOverResult, field: NormalizedField, value: unknown): Promise<void> {
  if (!Array.isArray(value) || value.length === 0) return;
  const results = await Promise.all(
    value.map(async (id) => {
      try {
        await kit.contracts.getAttachment({ attachmentId: String(id) });
        return "ok" as const;
      } catch (error) {
        return error instanceof CangeApiError && error.status === 404 ? ("missing" as const) : ("unknown" as const);
      }
    })
  );
  const missing = value.filter((_, index) => results[index] === "missing").map(String);
  if (missing.length === 0) return;
  // O InputAttach carrega um por um e para no primeiro que falha: não mostra nenhum.
  applyScreenValue(carry, field, undefined, `anexo ${missing.join(", ")} que não existe mais; a tela não mostra os anexos do campo`);
}
