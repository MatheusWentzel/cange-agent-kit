import type { Command } from "commander";

import { extractFlowSteps } from "../../contracts/payload-builder.js";
import type { NormalizedField } from "../../schemas/fields.js";
import { dropEmpty } from "../../utils/lean.js";
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
      createCommandAction(async ({ kit, profile }, options: MapOptions) => {
        const lean = profile === "lean";
        const { summaries } = await kit.contracts.getMyFlows();

        const maxFlows = options.maxFlows !== undefined ? Number(options.maxFlows) : 15;
        const wanted = options.flowId
          ? summaries.filter((f) => String(f.id) === String(options.flowId))
          : summaries;
        const toDetail = wanted.slice(0, Number.isInteger(maxFlows) && maxFlows > 0 ? maxFlows : 15);

        const flowsOut = [];
        const leanFlows: Array<Record<string, unknown>> = [];
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
              // Rodada 5 (enxuto): sem o hash `name` (23% do map; o kit aceita o id
              // numérico do campo em `values` e traduz). `--full` traz o hash.
              const out: Record<string, unknown> = {
                id: f.id !== undefined ? Number(f.id) : undefined,
                ...(lean ? {} : { name: f.name }),
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

          if (lean) {
            leanFlows.push(
              summarizeFlow({
                id: flowId,
                name: flow.title,
                formInitId: flow.formInitId !== undefined ? Number(flow.formInitId) : undefined,
                steps,
                fields: fieldSet.fields.filter((f) => f.type !== "DIVIDER_FIELD"),
                links: rawLinkById
              })
            );
            continue;
          }
          flowsOut.push({
            id: flowId,
            name: flow.title,
            formInitId: flow.formInitId !== undefined ? Number(flow.formInitId) : undefined,
            steps,
            fields
          });
        }

        if (lean) {
          // Rodada 5: `relationships`/`registersUsed` repetiam o `linksToFlowId`/
          // `registerId` que já está em cada campo; a dica vive no bloco do CLI.
          return dropEmpty({
            totalFlows: summaries.length,
            mappedFlows: leanFlows.length,
            truncated: wanted.length > toDetail.length,
            flows: leanFlows
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
      "Enxuto (padrão, resumido): { totalFlows, mappedFlows, truncated, flows[{id, name, formInitId, startFields[campo], steps[{id, name, fields[campo]}], otherFields?[campo + formId]}] }, " +
      `campo = {id, title, type, required? (só quando obrigatório), options? (rótulos, até ${MAP_OPTIONS_INLINE_MAX}) | optionsCount? (mais que isso: lista em \`fields by-flow\`), linksToFlowId?, registerId?}. ` +
      "Com --full: { totalFlows, mappedFlows, truncated, flows[{id,name,formInitId,steps[],fields[{id,name(hash),...}]}], relationships[], registersUsed[], dica }",
    fieldsLocation:
      "enxuto: startFields = formulário de criação; steps[].fields = campos de cada etapa. --full: flows[].fields[].formId × flows[].steps[].formId distingue criação e etapa; relationships liga flows via COMBO_BOX_FLOW_FIELD",
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

/** C4: opções em linha só quando poucas; mais que isso, só a contagem. */
const MAP_OPTIONS_INLINE_MAX = 8;

/**
 * C4 (card #1367459): mapa RESUMIDO. "Mapear os fluxos e as etapas" custava ~1.750
 * tokens por vez e repetia no mesmo run (13 vezes em produção). Os campos ficam
 * agrupados no formulário de criação e em cada etapa (sai o `formId` de cada campo e
 * de cada etapa), `required` só aparece quando é obrigatório e a etapa leva id e nome.
 */
function summarizeFlow(input: {
  id: number;
  name: string | undefined;
  formInitId: number | undefined;
  steps: Array<{ id?: number; index?: number; name?: string; formId?: number }>;
  fields: NormalizedField[];
  links: Map<string, RawFieldLink>;
}): Record<string, unknown> {
  const byForm = new Map<string, Array<Record<string, unknown>>>();
  for (const field of input.fields) {
    const key = field.formId !== undefined ? String(field.formId) : "";
    const bucket = byForm.get(key) ?? [];
    bucket.push(leanField(field, input.links));
    byForm.set(key, bucket);
  }
  const take = (formId: number | undefined): Array<Record<string, unknown>> => {
    if (formId === undefined) return [];
    const key = String(formId);
    const list = byForm.get(key) ?? [];
    byForm.delete(key);
    return list;
  };

  const startFields = take(input.formInitId);
  const steps = [...input.steps]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((step) => ({ id: step.id, name: step.name, fields: take(step.formId) }));
  const otherFields: Array<Record<string, unknown>> = [];
  for (const [formId, list] of byForm) {
    for (const field of list) otherFields.push({ ...field, formId: formId ? Number(formId) : undefined });
  }
  return {
    id: input.id,
    name: input.name,
    formInitId: input.formInitId,
    startFields,
    steps,
    otherFields
  };
}

function leanField(field: NormalizedField, links: Map<string, RawFieldLink>): Record<string, unknown> {
  const link = field.id !== undefined ? links.get(String(field.id)) : undefined;
  const labels = optionLabels(field.options);
  return {
    id: field.id !== undefined ? Number(field.id) : undefined,
    title: field.title,
    type: field.type,
    ...(field.required ? { required: true } : {}),
    ...(labels.length > 0 && labels.length <= MAP_OPTIONS_INLINE_MAX ? { options: labels } : {}),
    ...(labels.length > MAP_OPTIONS_INLINE_MAX ? { optionsCount: labels.length } : {}),
    ...(link?.flowId !== undefined ? { linksToFlowId: link.flowId } : {}),
    ...(link?.registerId !== undefined ? { registerId: link.registerId } : {})
  };
}

/** Um rótulo por opção (título/rótulo; sem rótulo, o valor). */
function optionLabels(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const labels: string[] = [];
  for (const option of options) {
    let label: string | undefined;
    if (typeof option === "string" || typeof option === "number") {
      label = String(option);
    } else if (isRecord(option)) {
      for (const key of ["title", "label", "name", "text", "value", "id"]) {
        const value = option[key];
        if ((typeof value === "string" && value.trim() !== "") || typeof value === "number") {
          label = String(value).trim();
          break;
        }
      }
    }
    if (label !== undefined && !labels.includes(label)) labels.push(label);
  }
  return labels;
}
