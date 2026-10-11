import { CangeApiError } from "../client/errors.js";
import { clientReadsHoldingWindow } from "../client/http.js";
import { asRecord, extractArray } from "../contracts/raw-adapters.js";
import type { CangeAgentKit } from "../index.js";
import type { NormalizedField } from "../schemas/fields.js";
import { applyScreenValue, resolveLocalScreenValues, type CarryOverResult } from "../utils/carryOver.js";
import { normalizeFieldType } from "../utils/fieldTypeGuards.js";
import { createReadWindowPacer, ReadBudgetExceededError, type Throttle } from "../utils/rateLimit.js";
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
 *
 * Teto de leitura do back (10 GET/s por chave numa janela fixa de 1 s; estourar bloqueia a chave
 * por 5 minutos): estas leituras saem uma por vez, e cada uma só começa quando menos de 8 GETs da
 * credencial do cliente (N-1: o registro é por credencial), os que o mover fez antes daqui também,
 * ainda podem cair na mesma janela do back que ela (`createReadWindowPacer`). Os anexos vão um por um, parando no primeiro que não existe, como a tela.
 *
 * REG-F1 (07/10): o ritmo fixo de 2 por segundo levava 22 s no cartão 921055 (43 anexos) e estourava
 * o prazo de 15 s da conferência do gate: o agente nunca conseguia pedir aprovação. Agora o ritmo é o
 * do teto (43 anexos em uns 5 s) e a conferência tem prazo (`DEFAULT_SCREEN_REFS_BUDGET_MS`): a
 * leitura que não começaria a tempo não é feita, o valor gravado fica como está (o kit não afirma o
 * que não leu) e o campo sai no aviso (`carry.unchecked`). Assim o mover sempre responde.
 * `CANGE_SCREEN_REFS_RPS` (GETs por janela de 1 s) e `CANGE_SCREEN_REFS_BUDGET_MS` mudam os dois,
 * para teste.
 */
const DEFAULT_SCREEN_REFS_PER_SECOND = 8;
/** Prazo da conferência: com o resto do mover, cabe com folga nos 15 s da conferência do gate. */
export const DEFAULT_SCREEN_REFS_BUDGET_MS = 8_000;

function screenRefsPerSecond(): number {
  const raw = Number(process.env.CANGE_SCREEN_REFS_RPS);
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : DEFAULT_SCREEN_REFS_PER_SECOND;
}

function screenRefsBudgetMs(): number {
  const raw = process.env.CANGE_SCREEN_REFS_BUDGET_MS;
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SCREEN_REFS_BUDGET_MS;
}

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
  const throttle = createReadWindowPacer({
    maxPerWindow: screenRefsPerSecond(),
    holding: clientReadsHoldingWindow(kit.client),
    deadlineAt: Date.now() + screenRefsBudgetMs()
  });
  await Promise.all(
    fields.map(async (field) => {
      if (!(field.name in carry.values)) return;
      const type = normalizeFieldType(field.type);
      const value = carry.values[field.name];
      try {
        if (SCREEN_USER_TYPES.has(type)) {
          if (typeof value !== "number") return;
          const allowed = await screenUsersFor(kit, field, userLists, undefined, throttle);
          if (!allowed || allowed.has(value)) return;
          applyScreenValue(
            carry,
            field,
            undefined,
            `usuário ${value} bloqueado, leitor do fluxo ou fora do fluxo privado; a tela não o lista`,
            !userEmptyBlocks(field)
          );
        } else if (type === "COMBO_BOX_FLOW_FIELD") {
          await resolveConnectedCards(kit, carry, field, value, input.flowId, throttle);
        } else if (type === "INPUT_ATTACH_FIELD") {
          await resolveAttachments(kit, carry, field, value, throttle);
        }
      } catch (error) {
        if (!(error instanceof ReadBudgetExceededError)) throw error;
        markUnchecked(carry, field, error instanceof UncheckedAttachments ? error.what : uncheckedWhat(type, value));
      }
    })
  );
}

/** O prazo acabou no meio dos anexos do campo: quantos ficaram sem conferir. */
class UncheckedAttachments extends ReadBudgetExceededError {
  constructor(readonly what: string) {
    super();
  }
}

/** O que ficou sem conferir no campo de usuário ou de cartão conectado (o de anexo diz quantos). */
function uncheckedWhat(type: string, value: unknown): string {
  if (type === "COMBO_BOX_FLOW_FIELD") return `cartão conectado ${Array.isArray(value) ? value.join(", ") : String(value)}`;
  return `usuário ${String(value)}`;
}

function markUnchecked(carry: CarryOverResult, field: NormalizedField, what: string): void {
  const list = (carry.unchecked ?? []).filter((item) => item.name !== field.name);
  list.push({ name: field.name, ...(field.title ? { title: field.title } : {}), what });
  carry.unchecked = list;
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
  parentFlowId: number | string | undefined,
  throttle: Throttle
): Promise<void> {
  if (!Array.isArray(value) || value.length === 0) return;
  const linkedFlow = field.raw?.flow_id;
  if (linkedFlow === undefined || linkedFlow === null || String(linkedFlow).trim() === "") return;
  let response: unknown;
  try {
    response = await throttle.run(() =>
      kit.contracts.getCardsByIds({
        flowId: String(linkedFlow),
        ...(parentFlowId !== undefined ? { parentFlowId } : {}),
        cardIds: value.map((item) => String(item))
      })
    );
  } catch (error) {
    // REG-F1: o prazo acabou antes da leitura; quem chamou marca o campo como não conferido.
    if (error instanceof ReadBudgetExceededError) throw error;
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

async function resolveAttachments(
  kit: CangeAgentKit,
  carry: CarryOverResult,
  field: NormalizedField,
  value: unknown,
  throttle: Throttle
): Promise<void> {
  if (!Array.isArray(value) || value.length === 0) return;
  // O InputAttach carrega um por um e para no primeiro que falha: não mostra nenhum do campo.
  for (const [index, id] of value.entries()) {
    try {
      await throttle.run(() => kit.contracts.getAttachment({ attachmentId: String(id) }));
    } catch (error) {
      if (error instanceof ReadBudgetExceededError) {
        const left = value.length - index;
        throw new UncheckedAttachments(`${left} de ${value.length} anexo${value.length === 1 ? "" : "s"}`);
      }
      if (error instanceof CangeApiError && error.status === 404) {
        applyScreenValue(carry, field, undefined, `anexo ${String(id)} que não existe mais; a tela não mostra os anexos do campo`);
      }
      // Outra falha (rede, 5xx): o kit não afirma o que não conferiu.
      return;
    }
  }
}
