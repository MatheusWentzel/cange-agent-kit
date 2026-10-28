import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../../client/errors.js";
import {
  createFlowPayloadSchema,
  updateFlowPayloadSchema
} from "../../../schemas/flowV2Build.js";
import { createDryRunResult } from "../../../utils/dryRun.js";
import { annotateCommand } from "../../command-metadata.js";
import { createCommandAction } from "../../context.js";
import { readPayloadFile } from "../../helpers.js";

interface FlowCreateOptions {
  payload: string;
  dryRun?: boolean;
}

interface FlowUpdateOptions {
  idFlow?: string;
  payload: string;
  dryRun?: boolean;
}

/**
 * Onda 4 (B5, N10/S67): o fluxo criado pelo agente "sumia" para quem pediu. No back
 * (`POST /flow/v2/build/flows`) não existe rascunho que esconda o fluxo: a coluna
 * `rascunho` nasce "S" em todo fluxo (o ManageFlowService grava "S" quando não vem valor,
 * também no PATCH) e nenhuma lista nem a tela a lê. O que esconde é:
 *  - sem nome: as listas tiram fluxo com `name` nulo de todo mundo menos de quem criou
 *    (o "rascunho" de verdade do Cange);
 *  - privado (`isPrivate` "1", o padrão da rota): só membros do fluxo veem (Meus fluxos e o
 *    link), e a rota põe só quem criou como membro (administrador do fluxo).
 * A saída diz o estado e onde o fluxo aparece, e o `notice` diz o que avisar a quem pediu.
 */
export interface FlowPlacement {
  id_flow?: number;
  name: string | null;
  link?: string;
  state: "rascunho" | "publicado";
  visibility: "privado" | "ambiente";
}

export function flowPlacement(
  raw: unknown,
  payload: { name?: string; isPrivate?: string },
  appOrigin: string,
  justCreated = true
): { flow: FlowPlacement; notice: string } {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const idFlow = Number(record.id_flow);
  const id = Number.isInteger(idFlow) && idFlow > 0 ? idFlow : undefined;
  const rawName = "name" in record ? record.name : payload.name;
  // Nome vazio ou só espaços conta como sem nome: o back lista, mas como linha em branco,
  // e quem pediu não acha o fluxo pelo nome. O aviso é o mesmo do nome nulo (dê o nome).
  const name = typeof rawName === "string" && rawName.trim() !== "" ? rawName : null;
  const rawPrivate = "isPrivate" in record ? record.isPrivate : (payload.isPrivate ?? "1");
  const isPublic = rawPrivate === null || rawPrivate === undefined || String(rawPrivate).trim() === "0";
  const hash = typeof record.hash === "string" && record.hash.trim() ? record.hash.trim() : undefined;
  const flow: FlowPlacement = {
    ...(id !== undefined ? { id_flow: id } : {}),
    name,
    ...(hash ? { link: `${appOrigin.replace(/\/+$/, "")}/flow/${hash}` } : {}),
    state: name === null ? "rascunho" : "publicado",
    visibility: isPublic ? "ambiente" : "privado"
  };
  const idText = id !== undefined ? String(id) : "<id>";
  const update = (body: string): string =>
    `\`cange flow-build flow update --id-flow ${idText} --payload <arquivo com ${body}>\``;
  if (flow.state === "rascunho") {
    return {
      flow,
      notice:
        `O fluxo ${idText} está em rascunho porque não tem nome: quem pediu não o acha nas listas. ` +
        `Dê o nome com ${update('{"name": "<nome>"}')} e avise quem pediu.`
    };
  }
  const where = flow.link ? `"${name}" (${flow.link})` : `"${name}"`;
  if (flow.visibility === "ambiente") {
    return {
      flow,
      notice: `O fluxo ${where} está publicado e aparece em Meus fluxos para todos do ambiente. Avise quem pediu com o nome e o link.`
    };
  }
  return {
    flow,
    notice:
      `O fluxo ${where} está publicado, mas é privado: só os membros veem` +
      (justCreated ? ", e hoje o único membro é quem criou. Quem pediu não o acha em Meus fluxos nem abre o link. " : ". ") +
      "Avise quem pediu com o nome e o link, e diga que um " +
      "administrador do ambiente dá acesso em Painel do Administrador > Controle de Acesso > Fluxos > Acessos. " +
      `Se quem pediu quiser que todos do ambiente vejam: ${update('{"isPrivate": "0"}')}.`
  };
}

export function registerFlowBuildFlowCommands(flowBuildCommand: Command): void {
  const command = flowBuildCommand
    .command("flow")
    .description("Operações de criação/atualização de fluxo (build)");

  const create = command
    .command("create")
    .description("MUTAÇÃO: cria fluxo (POST /flow/v2/build/flows)")
    .requiredOption("--payload <path>", "Caminho do JSON do body")
    .option("--dry-run", "Valida payload localmente sem chamar API")
    .action(
      createCommandAction(async ({ kit }, options: FlowCreateOptions) => {
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = createFlowPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para flow-build flow create.", {
            details: parsed.error.format()
          });
        }
        if (options.dryRun) {
          return createDryRunResult(parsed.data);
        }
        const result = await kit.contracts.createFlowBuildFlow(parsed.data);
        return { ...result, ...flowPlacement(result.raw, parsed.data, kit.config.appOrigin) };
      })
    );

  annotateCommand(create, {
    mutates: true,
    envelope:
      '{ raw, flow: { id_flow, name, link, state: "rascunho"|"publicado", visibility: "privado"|"ambiente" }, notice }',
    fieldsLocation:
      "id_flow e form_init_id em `raw`; `notice` diz onde o fluxo aparece e o que avisar a quem pediu (repasse a ela)",
    example: "flow-build flow create --payload ./fluxo.json"
  });

  command
    .command("update")
    .description("MUTAÇÃO: atualiza metadados do fluxo (PATCH /flows/:id_flow)")
    .requiredOption("--id-flow <id>", "ID do flow")
    .requiredOption("--payload <path>", "Caminho do JSON do body")
    .option("--dry-run", "Valida payload localmente sem chamar API")
    .action(
      createCommandAction(async ({ kit }, options: FlowUpdateOptions) => {
        if (!options.idFlow) {
          throw new CangeCliUsageError("Informe --id-flow.");
        }
        const payloadRaw = await readPayloadFile<unknown>(options.payload);
        const parsed = updateFlowPayloadSchema.safeParse(payloadRaw);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para flow-build flow update.", {
            details: parsed.error.format()
          });
        }
        if (options.dryRun) {
          return createDryRunResult({ idFlow: options.idFlow, payload: parsed.data });
        }
        const result = await kit.contracts.updateFlowBuildFlow({
          idFlow: options.idFlow,
          payload: parsed.data
        });
        // O PATCH devolve o fluxo inteiro: `flow` sai sempre; o `notice` (o que avisar a quem
        // pediu) só quando o pedido mexe no nome ou na visibilidade, não em cor ou ícone.
        const { flow, notice } = flowPlacement(result.raw, {}, kit.config.appOrigin, false);
        const touchesPlacement = parsed.data.name !== undefined || parsed.data.isPrivate !== undefined;
        return { ...result, flow, ...(touchesPlacement ? { notice } : {}) };
      })
    );
}
