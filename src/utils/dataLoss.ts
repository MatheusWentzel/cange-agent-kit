import type { CangeAgentKit } from "../index.js";
import type { NormalizedField } from "../schemas/fields.js";
import { asRecord } from "../contracts/raw-adapters.js";

/**
 * Detecção de perda de dados em move-step (read-before-write).
 *
 * O endpoint `/card/v2/move-step` cria um form_answer NOVO a cada move, gravando
 * apenas os campos presentes em `values`. Campos já preenchidos no card que não
 * forem reenviados ficam ausentes do snapshot novo — perda silenciosa de dados.
 *
 * Este utilitário lê o estado atual do card antes do move e aponta os campos
 * preenchidos do form alvo que NÃO estão no `values` do payload (os "órfãos").
 * É resiliente por construção: qualquer falha de leitura degrada para um aviso
 * não-bloqueante, nunca impede uma mutação legítima.
 */

export interface OrphanField {
  fieldName: string;
  fieldTitle?: string;
  currentValue: string;
}

export interface DataLossCheck {
  checked: boolean;
  orphans: OrphanField[];
  note: string;
}

interface DetectDataLossInput {
  kit: CangeAgentKit;
  payload: {
    flowId: number;
    cardId: number;
    /** Opcional: quando omitido no move, o form da etapa de origem é resolvido no contrato. */
    idForm?: number;
    values: Record<string, unknown>;
  };
  /** Fields do form alvo já carregados (reuso quando --validate-fields rodou antes). */
  targetFields?: NormalizedField[];
}

interface FilledValue {
  title?: string;
  value: string;
}

export async function detectDataLoss(input: DetectDataLossInput): Promise<DataLossCheck> {
  const { kit, payload } = input;
  const idForm = payload.idForm;

  // Sem idForm não há como escopar a checagem a um form. Nesse caso o form da etapa
  // de origem é resolvido no contrato do move; aqui apenas pulamos (best-effort).
  if (idForm == null) {
    return {
      checked: false,
      orphans: [],
      note: "idForm omitido — checagem de perda de dados pulada (form da etapa de origem resolvido no contrato)."
    };
  }

  try {
    // Fields são OPCIONAIS — servem só para enriquecer o título do campo na
    // mensagem. A detecção em si usa o `field.name` (hash) que já vem no card raw,
    // então NÃO dependemos do /field/by-flow (endpoint que pode responder 401
    // "JWT missing" mesmo autenticado). Se a busca falhar, seguimos sem título.
    let targetFields = input.targetFields;
    if (!targetFields) {
      try {
        const fieldsData = await kit.contracts.getFieldsByFlow({ flowId: payload.flowId });
        targetFields = fieldsData.fields.filter(
          (field) => String(field.formId) === String(idForm)
        );
      } catch {
        targetFields = undefined;
      }
    }

    const fieldById = new Map<string, NormalizedField>();
    for (const field of targetFields ?? []) {
      if (field.id !== undefined) {
        fieldById.set(String(field.id), field);
      }
    }

    const card = await kit.contracts.getCard({
      flowId: payload.flowId,
      cardId: payload.cardId
    });

    const filled = extractFilledFields(card.raw, idForm, fieldById);
    const payloadNames = new Set(Object.keys(payload.values));

    const orphans: OrphanField[] = [];
    for (const [fieldName, info] of filled) {
      if (!payloadNames.has(fieldName)) {
        orphans.push({ fieldName, fieldTitle: info.title, currentValue: info.value });
      }
    }

    return {
      checked: true,
      orphans,
      note:
        orphans.length > 0
          ? `O card tem ${orphans.length} campo(s) preenchido(s) no form ${idForm} ausente(s) do values. ` +
            "O move criará um snapshot SEM eles (perda de dados). Inclua-os no values (read-before-move) " +
            "ou confirme a perda com --allow-data-loss."
          : "Nenhum campo preenchido seria perdido pelo move."
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      checked: false,
      orphans: [],
      note: `Não foi possível verificar perda de dados (segue sem bloquear): ${message}`
    };
  }
}

/**
 * Reconstrói o estado atual dos campos preenchidos do form alvo a partir do raw
 * do card. Varre todos os form_answers ativos do form (deleted != "S"), do mais
 * antigo para o mais recente, deixando o snapshot mais recente vencer por campo —
 * espelhando o que a UI exibe. Campo esvaziado no snapshot mais recente é removido.
 */
function extractFilledFields(
  raw: unknown,
  idForm: number | string,
  fieldById: Map<string, NormalizedField>
): Map<string, FilledValue> {
  const filled = new Map<string, FilledValue>();
  const cardRecord = findCardRecord(raw);
  if (!cardRecord) {
    return filled;
  }

  const formAnswers = toArray(cardRecord.form_answers)
    .map(asRecord)
    .filter((fa): fa is Record<string, unknown> => fa !== undefined)
    .filter((fa) => String(fa.form_id ?? fa.id_form) === String(idForm))
    .filter((fa) => !isDeleted(fa))
    .sort(compareByRecencyAsc);

  for (const answer of formAnswers) {
    const answerFields = toArray(answer.form_answer_fields)
      .map(asRecord)
      .filter((af): af is Record<string, unknown> => af !== undefined)
      .filter((af) => !isDeleted(af));

    for (const answerField of answerFields) {
      const fieldRecord = asRecord(answerField.field);
      const fieldId =
        firstDefined(answerField.field_id, answerField.id_field) ??
        firstDefined(fieldRecord?.id_field, fieldRecord?.id, fieldRecord?.field_id);
      const known = fieldId !== undefined ? fieldById.get(String(fieldId)) : undefined;

      const fieldName = known?.name ?? asString(fieldRecord?.name);
      if (!fieldName) {
        // Sem o name não há como cruzar com `values` (que é chaveado por field.name).
        continue;
      }

      const value = asString(answerField.valueString) ?? asString(answerField.value);
      if (value === undefined || value.trim().length === 0) {
        filled.delete(fieldName);
        continue;
      }

      filled.set(fieldName, {
        title: known?.title ?? asString(fieldRecord?.title),
        value
      });
    }
  }

  return filled;
}

function findCardRecord(raw: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(raw);
  if (!direct) {
    return undefined;
  }
  if (Array.isArray(direct.form_answers)) {
    return direct;
  }
  for (const key of ["card", "data", "item", "result"]) {
    const nested = asRecord(direct[key]);
    if (nested && Array.isArray(nested.form_answers)) {
      return nested;
    }
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
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function compareByRecencyAsc(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): number {
  const dateA = asString(a.dt_created) ?? "";
  const dateB = asString(b.dt_created) ?? "";
  if (dateA !== dateB) {
    return dateA < dateB ? -1 : 1;
  }
  const idA = Number(firstDefined(a.id_form_answer, a.id) ?? 0);
  const idB = Number(firstDefined(b.id_form_answer, b.id) ?? 0);
  return idA - idB;
}
