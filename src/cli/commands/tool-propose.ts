import type { Command } from "commander";

import { CangeApiError } from "../../client/errors.js";
import { buildApiToolProposalBody, type ApiToolProposalResult } from "../../contracts/apiToolProposal.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { dropEmpty } from "../../utils/lean.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";

/**
 * Onda 3 (bloco D): `cange tool propose --spec <arquivo.json>` — o agente PROPÕE uma
 * ferramenta de API para si mesmo. Só cria o PEDIDO no servidor
 * (`POST /agent-api-tool-proposal`); a ferramenta passa a valer quando quem administra
 * o agente revisa, digita a credencial num campo seguro e aprova. Não pausa a
 * execução. `--dry-run` confere e mostra o corpo sem enviar.
 */

interface ToolProposeOptions {
  spec: string;
  dryRun?: boolean;
}

/** Próximo passo por código do back (complement.code), anexado à mensagem do erro. */
const PROPOSE_ERROR_HINTS: Record<string, string> = {
  API_TOOL_PROPOSE_DISABLED:
    "Quem administra o agente desligou \"Propor ferramentas de API\" (Ferramentas). Não proponha de novo; diga ao usuário que quem administra o agente pode cadastrar a ferramenta na aba Ferramentas.",
  API_TOOL_PROPOSALS_PENDING_LIMIT:
    "Já há ferramentas esperando aprovação. Não proponha outra agora; diga ao usuário que as propostas anteriores aguardam decisão em Aprovações.",
  API_TOOL_PROPOSAL_SECRET_VALUE:
    "Tire o valor da credencial da especificação e diga só o cabeçalho em secret_headers (sem valor). Nunca peça a credencial na conversa.",
  API_TOOL_PROPOSAL_HOST_BLOCKED: "Esse endereço é de rede interna e não pode virar ferramenta. Diga isso ao usuário.",
  INVALID_API_TOOL_PROPOSAL: "Corrija a especificação (veja `cange tool propose --help`) e rode de novo uma vez.",
  AGENT_INACTIVE: "O agente está desativado: não dá para propor ferramenta. Diga ao usuário que o agente precisa ser reativado.",
  PLAN_MODE_WRITE_BLOCKED:
    "Em \"Planejar\" a proposta não é enviada: descreva na resposta a ferramenta que você proporia (nome, chamada, parâmetros e onde vai a credencial)."
};

/**
 * Back antigo (sem a rota): o gate do token de run responde 403 sem código ("Ação
 * não permitida") ou a rota não existe (404). Mensagem clara em vez do erro cru.
 */
export const PROPOSE_UNSUPPORTED_MESSAGE =
  "Este ambiente do Cange ainda não aceita proposta de ferramenta de API. Não tente de novo; diga ao usuário que quem " +
  "administra o agente pode cadastrar a ferramenta na aba Ferramentas do agente.";

function complementCode(error: CangeApiError): string | undefined {
  const details = error.details as { complement?: { code?: unknown }; code?: unknown } | undefined;
  const code = details?.complement?.code ?? details?.code;
  return typeof code === "string" ? code : undefined;
}

/** Traduz o erro do back na próxima ação do agente. Puro (exportado para teste). */
export function withProposeHint(error: unknown): unknown {
  if (!(error instanceof CangeApiError)) return error;
  const code = complementCode(error);
  const hint = code ? PROPOSE_ERROR_HINTS[code] : undefined;
  if (hint) {
    error.message = `${error.message} ${hint}`;
    return error;
  }
  if (!code && (error.status === 404 || error.status === 403)) {
    error.message = PROPOSE_UNSUPPORTED_MESSAGE;
  }
  return error;
}

/** Frase pronta para a resposta ao usuário. Pura. */
export function toolProposalSentence(result: Pick<ApiToolProposalResult, "deduped">, name: string): string {
  return result.deduped
    ? `A ferramenta "${name}" já estava esperando a aprovação de quem administra o agente.`
    : `Propus a ferramenta de API "${name}". Ela só passa a valer quando quem administra o agente revisar, digitar a credencial e aprovar em Aprovações.`;
}

export function registerToolProposeCommand(toolCommand: Command): void {
  const command = toolCommand
    .command("propose")
    .description(
      "PEDIDO DE FERRAMENTA: propõe uma ferramenta de API para o próprio agente (não pausa a execução); ela só vale depois que quem administra o agente revisa, digita a credencial e aprova"
    )
    .requiredOption(
      "--spec <arquivo.json>",
      "JSON { name, description, method, url (https, {param} no caminho), query?, headers?, body?, timeout?, params?, secret_headers?: [{key, hint}] (SEM valor), docs_url?, reason? }"
    )
    .option("--dry-run", "Confere e mostra o pedido sem enviar")
    .action(
      createCommandAction(async ({ kit }, options: ToolProposeOptions) => {
        const spec = await readPayloadFile<unknown>(options.spec);
        const body = buildApiToolProposalBody(spec);

        if (options.dryRun) {
          return createDryRunResult(body);
        }

        let result: ApiToolProposalResult;
        try {
          result = await kit.contracts.proposeApiTool(body);
        } catch (error) {
          throw withProposeHint(error);
        }
        const sentence = toolProposalSentence(result, body.name);
        return dropEmpty({
          approvalId: result.approvalId,
          status: result.status,
          deduped: result.deduped,
          summary: result.summary,
          message: sentence,
          note: result.deduped
            ? `Esse pedido já estava aguardando decisão (#${result.approvalId ?? "?"}). Não proponha de novo. Na resposta, diga: "${sentence}"`
            : `Pedido de ferramenta #${result.approvalId ?? "?"} aberto. Não espere a decisão, não repita o comando e não peça a credencial. Na resposta, diga: "${sentence}"`
        });
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope: "{ approvalId, status:'pending', deduped, summary, message, note }",
    fieldsLocation:
      "Cria um PEDIDO de ferramenta de API no servidor (não cria a ferramenta e não pausa a execução). A credencial nunca " +
      "vai no --spec: secret_headers diz só o cabeçalho; quem administra digita o valor. `message` é a frase pronta para a resposta.",
    example:
      "tool propose --spec ./ferramenta-cep.json  (com {\"name\":\"Consulta de CEP\",\"description\":\"Endereço de um CEP\",\"method\":\"GET\"," +
      "\"url\":\"https://viacep.com.br/ws/{cep}/json\",\"params\":[{\"name\":\"cep\",\"required\":true}]})"
  });
}
