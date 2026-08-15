import type { Command } from "commander";

import { extractFlowSteps } from "../../contracts/payload-builder.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

interface MapOptions {
  flowId?: string;
  maxFlows?: string;
}

/**
 * `cange map` — o MAPA do ambiente em UMA chamada.
 *
 * Por quê: um agente sem mapa reconstrói o ambiente na unha (my-flows + flow get
 * + fields by-flow + tentativa-e-erro por flow) — caso real: o agente Comprador
 * gastou ~30 passos/turnos só entendendo a estrutura Pedido→Fornecedor→Itens
 * (run card 1219728, US$2,10). Este comando devolve compacto:
 *   · os flows que o usuário acessa (id, nome, nº de cards);
 *   · as ETAPAS de cada flow (id, nome, form da etapa);
 *   · os CAMPOS de cada flow (id, hash `name`, título, tipo, obrigatório, form)
 *     — com o form de criação identificado (formInitId);
 *   · os RELACIONAMENTOS entre flows (campos COMBO_BOX_FLOW_FIELD: quem aponta
 *     para quem) e os cadastros usados (COMBO_BOX_REGISTER_FIELD).
 *
 * Com o mapa, o agente sabe onde cada dado vive ANTES de agir: em qual flow está
 * o card, qual etapa tem qual campo, e como Pedido/Fornecedor/Itens se ligam.
 */
export function registerMapCommand(program: Command): void {
  const command = program
    .command("map")
    .description(
      "MAPA do ambiente em 1 chamada: flows + etapas + campos + relacionamentos entre flows (rode ANTES de explorar na unha)"
    )
    .option("--flow-id <id>", "Mapeia só este flow (mais rápido/enxuto)")
    .option("--max-flows <n>", "Máximo de flows a detalhar (default 15)")
    .action(
      createCommandAction(async ({ kit }, options: MapOptions) => {
        const { summaries } = await kit.contracts.getMyFlows();

        const maxFlows = options.maxFlows !== undefined ? Number(options.maxFlows) : 15;
        const wanted = options.flowId
          ? summaries.filter((f) => String(f.id) === String(options.flowId))
          : summaries;
        const toDetail = wanted.slice(0, Number.isInteger(maxFlows) && maxFlows > 0 ? maxFlows : 15);

        const flowsOut = [];
        const relationships: Array<{
          fromFlowId: number;
          fieldId: number | string | undefined;
          fieldTitle: string | undefined;
          toFlowId: number;
        }> = [];
        const registersUsed: Array<{
          registerId: number;
          usedByFlowId: number;
          fieldId: number | string | undefined;
          fieldTitle: string | undefined;
        }> = [];

        for (const flow of toDetail) {
          const flowId = Number(flow.id);
          const [flowData, fieldSet] = await Promise.all([
            kit.contracts.getFlow({ idFlow: String(flowId) }),
            kit.contracts.getFieldsByFlow({ flowId })
          ]);

          const steps = extractFlowSteps(flowData.raw).map((step) => ({
            id: step.id !== undefined ? Number(step.id) : undefined,
            index: step.index !== undefined ? Number(step.index) : undefined,
            name: step.name,
            formId: step.formId !== undefined ? Number(step.formId) : undefined
          }));

          // Targets de vínculo (flow_id/register_id) vivem no RAW dos fields — o
          // normalized não os carrega. Indexa o raw por id pra enriquecer.
          const rawLinkById = indexRawFieldLinks(fieldSet.raw);

          const fields = fieldSet.fields
            .filter((f) => f.type !== "DIVIDER_FIELD")
            .map((f) => {
              const link = f.id !== undefined ? rawLinkById.get(String(f.id)) : undefined;
              const out: Record<string, unknown> = {
                id: f.id !== undefined ? Number(f.id) : undefined,
                name: f.name,
                title: f.title,
                type: f.type,
                required: f.required,
                formId: f.formId !== undefined ? Number(f.formId) : undefined
              };
              if (link?.flowId !== undefined) {
                out.linksToFlowId = link.flowId;
                relationships.push({
                  fromFlowId: flowId,
                  fieldId: out.id as number | undefined,
                  fieldTitle: f.title,
                  toFlowId: link.flowId
                });
              }
              if (link?.registerId !== undefined) {
                out.registerId = link.registerId;
                registersUsed.push({
                  registerId: link.registerId,
                  usedByFlowId: flowId,
                  fieldId: out.id as number | undefined,
                  fieldTitle: f.title
                });
              }
              return out;
            });

          flowsOut.push({
            id: flowId,
            name: flow.title,
            formInitId: flow.formInitId !== undefined ? Number(flow.formInitId) : undefined,
            steps,
            fields
          });
        }

        return {
          totalFlows: summaries.length,
          mappedFlows: flowsOut.length,
          truncated: wanted.length > toDetail.length,
          flows: flowsOut,
          relationships,
          registersUsed,
          dica:
            "Campo com formId == formInitId pertence ao form de CRIAÇÃO (card update-values); " +
            "campo com formId de uma etapa (steps[].formId) é campo de ETAPA (card move-step-with-values). " +
            "relationships mostra os vínculos COMBO_BOX_FLOW_FIELD entre flows (use card relationship para ler os vínculos de um card específico)."
        };
      })
    );

  annotateCommand(command, {
    envelope:
      "{ totalFlows, mappedFlows, truncated, flows[{id,name,formInitId,steps[],fields[]}], relationships[], registersUsed[], dica }",
    fieldsLocation:
      "flows[].fields[].formId × flows[].steps[].formId distingue campo de criação vs de etapa; relationships liga flows via COMBO_BOX_FLOW_FIELD",
    example: "cange map            (ambiente inteiro)  ·  cange map --flow-id 22792   (um flow)"
  });
}

interface RawFieldLink {
  flowId?: number;
  registerId?: number;
}

/** Extrai, do raw de fields by-flow, os targets de vínculo por field id. */
function indexRawFieldLinks(raw: unknown): Map<string, RawFieldLink> {
  const map = new Map<string, RawFieldLink>();
  for (const record of iterateRawFieldRecords(raw)) {
    const id = record.id ?? record.field_id ?? record.id_field;
    if (id === undefined || id === null) continue;

    const link: RawFieldLink = {};
    const flowId = numberOrUndefined(record.flow_id);
    const registerId = numberOrUndefined(record.register_id);
    if (flowId !== undefined) link.flowId = flowId;
    if (registerId !== undefined) link.registerId = registerId;
    if (link.flowId !== undefined || link.registerId !== undefined) {
      map.set(String(id), link);
    }
  }
  return map;
}

function iterateRawFieldRecords(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw.filter(isRecord);
  }
  if (isRecord(raw)) {
    for (const key of ["fields", "items", "data", "results", "list"]) {
      const candidate = raw[key];
      if (Array.isArray(candidate)) {
        return candidate.filter(isRecord);
      }
    }
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}
