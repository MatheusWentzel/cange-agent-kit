import type { Command } from "commander";

import { CangeApiError, CangeValidationError } from "../../client/errors.js";
import { buildScheduleProposalBody, type ScheduleProposalResult } from "../../contracts/scheduleProposal.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { dropEmpty } from "../../utils/lean.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

/**
 * D3 (14/10/2026): `cange routine propose` — o agente PROPÕE uma rotina para si
 * mesmo. Só cria o PEDIDO no servidor (`POST /agent-schedule-proposal`); a rotina
 * passa a existir quando quem administra o agente aprova, em qualquer nível de
 * autonomia. Não pausa a execução. `--dry-run` mostra o corpo sem enviar.
 */

interface RoutineProposeOptions {
  name: string;
  instruction: string;
  frequency: string;
  time?: string;
  weekdays?: string;
  monthdays?: string;
  flow?: string;
  card?: string;
  dryRun?: boolean;
}

function positiveIntOrThrow(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CangeValidationError(`${flag} deve ser um inteiro positivo (recebido: ${raw}).`);
  }
  return value;
}

/** Próximo passo por código do back (complement.code), anexado à mensagem do erro. */
const ROUTINE_ERROR_HINTS: Record<string, string> = {
  SCHEDULE_PROPOSE_DISABLED:
    "Quem administra o agente desligou \"Propor rotinas\" (Ferramentas). Não proponha de novo; diga ao usuário que a rotina pode ser criada na aba Rotinas.",
  SCHEDULE_LIMIT_REACHED:
    "O agente chegou ao limite de rotinas. Não proponha outra; diga ao usuário para desligar ou excluir uma rotina na aba Rotinas.",
  SCHEDULE_PROPOSALS_PENDING_LIMIT:
    "Já há rotinas esperando aprovação. Não proponha outra agora; diga ao usuário que as propostas anteriores aguardam decisão.",
  AGENT_INACTIVE: "O agente está desativado: não dá para propor rotina. Diga ao usuário que o agente precisa ser reativado.",
  INVALID_SCHEDULE_TRIGGER: "Confira --frequency, --time, --weekdays ou --monthdays (veja `cange routine propose --help`)."
};

function complementCode(error: CangeApiError): string | undefined {
  const details = error.details as { complement?: { code?: unknown }; code?: unknown } | undefined;
  const code = details?.complement?.code ?? details?.code;
  return typeof code === "string" ? code : undefined;
}

function withRoutineHint(error: unknown): unknown {
  if (!(error instanceof CangeApiError)) return error;
  const code = complementCode(error);
  const hint = code ? ROUTINE_ERROR_HINTS[code] : undefined;
  if (hint) error.message = `${error.message} ${hint}`;
  return error;
}

/** Frase pronta para a resposta ao usuário. Pura. */
export function routineProposalSentence(result: Pick<ScheduleProposalResult, "summary" | "deduped">, name: string): string {
  return result.deduped
    ? `A rotina "${name}" já estava esperando a aprovação de quem administra o agente.`
    : `Propus a rotina "${name}". Ela só passa a valer quando quem administra o agente aprovar em Aprovações.`;
}

export function registerRoutineCommands(program: Command): void {
  const routine = program.command("routine").description("Rotinas do próprio agente (trabalho agendado)");

  const propose = routine
    .command("propose")
    .description(
      "PEDIDO DE ROTINA: propõe uma rotina para o próprio agente (não pausa a execução); a rotina só nasce quando quem administra o agente aprova"
    )
    .requiredOption("--name <nome>", "Nome da rotina (ex.: \"Cobrança do dia\")")
    .requiredOption("--instruction <texto>", "O que a rotina faz a cada execução (texto simples)")
    .requiredOption("--frequency <frequência>", "diaria | dias-uteis | semanal | mensal (a mais frequente é uma vez por dia)")
    .option("--time <HH:MM>", "Horário da rotina diária ou de dias úteis (um horário só)")
    .option("--weekdays <dias>", "Rotina semanal: seg,ter,qua,qui,sex,sab,dom (ou 0 a 6, 0 = domingo)")
    .option("--monthdays <dias>", "Rotina mensal: dias de 1 a 31, primeiro ou ultimo (ex.: 1,15,ultimo)")
    .option("--flow <id>", "Fluxo da rotina (id numérico). Sem fluxo, o resultado sai numa conversa nova a cada execução")
    .option("--card <id>", "Cartão de contexto (id numérico): entra na instrução da rotina")
    .option("--dry-run", "Mostra o pedido sem enviar")
    .action(
      createCommandAction(async ({ kit }, options: RoutineProposeOptions) => {
        const body = buildScheduleProposalBody({
          name: options.name,
          instruction: options.instruction,
          frequency: options.frequency,
          time: options.time,
          weekdays: options.weekdays,
          monthdays: options.monthdays,
          ...(options.flow !== undefined ? { flowId: positiveIntOrThrow(options.flow, "--flow") } : {}),
          ...(options.card !== undefined ? { cardId: positiveIntOrThrow(options.card, "--card") } : {})
        });

        if (options.dryRun) {
          return createDryRunResult(body);
        }

        let result: ScheduleProposalResult;
        try {
          result = await kit.contracts.proposeSchedule(body);
        } catch (error) {
          throw withRoutineHint(error);
        }
        const sentence = routineProposalSentence(result, body.name);
        return dropEmpty({
          approvalId: result.approvalId,
          status: result.status,
          deduped: result.deduped,
          summary: result.summary,
          message: sentence,
          note: result.deduped
            ? `Esse pedido já estava aguardando decisão (#${result.approvalId ?? "?"}). Não proponha de novo. Na resposta, diga: "${sentence}"`
            : `Pedido de rotina #${result.approvalId ?? "?"} aberto. Não espere a decisão nem repita o comando. Na resposta, diga: "${sentence}"`
        });
      })
    );

  annotateCommand(propose, {
    mutates: true,
    envelope: "{ approvalId, status:'pending', deduped, summary, message, note }",
    fieldsLocation:
      "Cria um PEDIDO de rotina no servidor (não cria a rotina e não pausa a execução). `summary` é o que quem aprova lê " +
      "(quando roda e o que faz). `message` é a frase pronta para a resposta.",
    example:
      "routine propose --name 'Cobrança do dia' --frequency diaria --time 08:00 --instruction 'Liste os boletos vencidos e avise no cartão de cada cliente'"
  });
}
