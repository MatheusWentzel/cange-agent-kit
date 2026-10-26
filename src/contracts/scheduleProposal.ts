import { CangeValidationError } from "../client/errors.js";
import type { CangeClient } from "../client/http.js";

/**
 * D3 (14/10/2026): o agente PROPÕE uma rotina (trabalho agendado) para si mesmo.
 * `POST /agent-schedule-proposal` (só token de run) só cria o PEDIDO de aprovação:
 * a rotina passa a existir quando quem administra o agente aprova, em qualquer
 * nível de autonomia. Negada, nada é criado.
 *
 * Frequências (as mesmas da tela de Rotinas; a mais frequente é uma vez por dia):
 *   · diaria      → gatilho 5, `--time HH:MM` (um horário);
 *   · dias-uteis  → gatilho 5 sem sábado e domingo, `--time HH:MM`;
 *   · semanal     → gatilho 6, `--weekdays seg,qua` (ou 0..6, 0 = domingo);
 *   · mensal      → gatilho 7, `--monthdays 1,15,ultimo` (1..31, primeiro, ultimo).
 */

export const SCHEDULE_FREQUENCIES = ["diaria", "dias-uteis", "semanal", "mensal"] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export interface ScheduleProposalInput {
  name: string;
  instruction: string;
  frequency: string;
  time?: string;
  weekdays?: string;
  monthdays?: string;
  flowId?: number;
  cardId?: number;
}

export interface ScheduleProposalBody {
  name: string;
  instruction: string;
  trigger_id: 5 | 6 | 7;
  trigger_config_fields: Record<string, unknown>;
  flow_id?: number;
  card_id?: number;
}

export interface ScheduleProposalResult {
  approvalId: number | null;
  deduped: boolean;
  status: string;
  summary: string;
}

const HOUR_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const WEEKDAY_ALIASES: Record<string, string> = {
  dom: "0", domingo: "0",
  seg: "1", segunda: "1",
  ter: "2", terca: "2", "terça": "2",
  qua: "3", quarta: "3",
  qui: "4", quinta: "4",
  sex: "5", sexta: "5",
  sab: "6", sabado: "6", "sábado": "6"
};

function normalizeFrequency(raw: string): ScheduleFrequency {
  const value = raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "-");
  const alias: Record<string, ScheduleFrequency> = {
    diaria: "diaria", diario: "diaria", "todo-dia": "diaria", daily: "diaria",
    "dias-uteis": "dias-uteis", "dia-util": "dias-uteis", uteis: "dias-uteis",
    semanal: "semanal", weekly: "semanal",
    mensal: "mensal", monthly: "mensal"
  };
  const found = alias[value];
  if (!found) {
    throw new CangeValidationError(
      `--frequency aceita diaria, dias-uteis, semanal ou mensal (recebido: ${raw}). Mais de uma vez por dia não existe.`
    );
  }
  return found;
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function weekdaysOf(raw: string | undefined): string[] {
  const out = splitList(raw).map((d) => WEEKDAY_ALIASES[d] ?? d);
  if (out.length === 0 || out.some((d) => !/^[0-6]$/.test(d))) {
    throw new CangeValidationError("--weekdays: use seg, ter, qua, qui, sex, sab, dom (ou 0 a 6, 0 = domingo), separados por vírgula.");
  }
  return Array.from(new Set(out)).sort((a, b) => Number(a) - Number(b));
}

function monthdaysOf(raw: string | undefined): string[] {
  const out = splitList(raw).map((d) => (d === "primeiro" ? "-1" : d === "ultimo" || d === "último" ? "-2" : d));
  const valid = (d: string) => d === "-1" || d === "-2" || (/^\d{1,2}$/.test(d) && Number(d) >= 1 && Number(d) <= 31);
  if (out.length === 0 || out.some((d) => !valid(d))) {
    throw new CangeValidationError("--monthdays: use dias de 1 a 31, primeiro ou ultimo, separados por vírgula.");
  }
  return Array.from(new Set(out)).sort((a, b) => Number(a) - Number(b));
}

/** Monta o corpo da rota a partir das flags (puro; erro de uso antes da rede). */
export function buildScheduleProposalBody(input: ScheduleProposalInput): ScheduleProposalBody {
  const name = (input.name ?? "").trim();
  const instruction = (input.instruction ?? "").trim();
  if (!name) throw new CangeValidationError("--name é obrigatório (o nome da rotina).");
  if (!instruction) throw new CangeValidationError("--instruction é obrigatório (o que a rotina faz a cada execução).");
  const frequency = normalizeFrequency(input.frequency ?? "");

  let trigger_id: 5 | 6 | 7;
  let trigger_config_fields: Record<string, unknown>;
  if (frequency === "diaria" || frequency === "dias-uteis") {
    const time = (input.time ?? "").trim();
    if (!HOUR_RE.test(time)) throw new CangeValidationError("--time é obrigatório na rotina diária, no formato HH:MM (um horário só).");
    trigger_id = 5;
    trigger_config_fields = { trigger_time_hour: [time], trigger_time_weekend: frequency === "dias-uteis" };
  } else if (frequency === "semanal") {
    trigger_id = 6;
    trigger_config_fields = { trigger_time_weekday: weekdaysOf(input.weekdays) };
  } else {
    trigger_id = 7;
    trigger_config_fields = { trigger_time_monthday: monthdaysOf(input.monthdays) };
  }

  return {
    name,
    instruction,
    trigger_id,
    trigger_config_fields,
    ...(input.flowId !== undefined ? { flow_id: input.flowId } : {}),
    ...(input.cardId !== undefined ? { card_id: input.cardId } : {})
  };
}

export function normalizeScheduleProposalResult(raw: unknown): ScheduleProposalResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = Number(r.approval_id);
  return {
    approvalId: Number.isInteger(id) && id > 0 ? id : null,
    deduped: r.deduped === true,
    status: typeof r.status === "string" ? r.status : "pending",
    summary: typeof r.summary === "string" ? r.summary : ""
  };
}

export interface ScheduleProposalContracts {
  proposeSchedule: (body: ScheduleProposalBody) => Promise<ScheduleProposalResult>;
}

export function createScheduleProposalContracts(client: CangeClient): ScheduleProposalContracts {
  return {
    async proposeSchedule(body) {
      const raw = await client.post<unknown>("/agent-schedule-proposal", { body });
      return normalizeScheduleProposalResult(raw);
    }
  };
}
