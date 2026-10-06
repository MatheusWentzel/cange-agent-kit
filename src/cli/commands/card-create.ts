import { promises as fs } from "node:fs";
import path from "node:path";

import type { Command } from "commander";
import type { z } from "zod";

import {
  CangeApiError,
  CangeCliUsageError,
  CangeError,
  CangeValidationError
} from "../../client/errors.js";
import { createCardPayloadSchema } from "../../schemas/cards.js";
import { runBatch, type BatchReport } from "../../utils/batchRunner.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import {
  BACKEND_WRITE_RPS_LIMIT,
  DEFAULT_WRITE_RPS,
  isRateLimitError,
  withRetry
} from "../../utils/rateLimit.js";
import type { CangeAgentKit } from "../../index.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction, withExitCode } from "../context.js";
import { exitCodeForBatch } from "../exit-codes.js";
import { readPayloadFile } from "../helpers.js";
import { EXIT_CODES } from "../exit-codes.js";
import { findMissingRequired, valuesOf, type ResolverLookups } from "../../utils/valueResolver.js";
import {
  addInlineValueOptions,
  authOnce as authOnceShared,
  createWriteLookups,
  fieldTitles,
  initScope,
  loadFlowContext,
  mergedValues,
  needsFieldResolution,
  otherStepScopes,
  parseInlineValues,
  resolveLayers,
  scopesFromFields,
  throwIfInvalid,
  validationSummary,
  type InlineValueOptions
} from "../write-support.js";

type CreateCardPayload = z.infer<typeof createCardPayloadSchema>;

interface CardCreateOptions extends InlineValueOptions {
  flowId?: string;
  payload?: string;
  payloadDir?: string;
  payloads?: string;
  validateFields?: boolean;
  dryRun?: boolean;
  full?: boolean;
  rps?: string;
  maxRetries?: string;
}

/**
 * Tentativas ADICIONAIS por card em 429 (o único erro seguro de repetir num
 * POST não idempotente — ver `shouldRetry` no create).
 */
const DEFAULT_MAX_RETRIES = 3;
/**
 * Teto de payloads por lote. Não é limite técnico: é para o lote continuar
 * cabendo numa execução de agente (com o rps default, 200 cards ≈ 25 s) e para
 * um diretório errado não virar uma rajada de milhares de escritas.
 */
const BATCH_MAX_PAYLOADS = 200;

/**
 * `cange card create` — cria UM card ou um LOTE de cards.
 *
 * O modo LOTE existe por causa de uma perda silenciosa de dados reproduzida em
 * produção (achado A4, runs 34/35 do agente Comprador, company 6728): o agente
 * criou 28 cards num loop de shell (`for f in *.json; do cange card create …`),
 * estourou o teto de escrita da API, a chave foi bloqueada por 5 minutos e 8
 * creates falharam. Como cada invocação era independente e ninguém conferia o
 * retorno, o agente seguiu vinculando os 28 ids que ESPERAVA — 8 deles nunca
 * existiram — e fechou a tarefa como sucesso, com 95% de confiança.
 *
 * O que o lote garante e o loop de shell não garantia:
 *   · UMA autenticação e UM processo para N cards (menos requisições);
 *   · throttle abaixo do teto de escrita + backoff/retry em 429;
 *   · PARADA ao detectar bloqueio (enquanto a chave está bloqueada, ~5 min,
 *     toda tentativa falha — seguir só queima requisição e tempo de execução);
 *   · resumo por payload: `created`/`failed`/`notAttempted` + os ids reais;
 *   · exit code 5 quando o lote sai incompleto — sucesso parcial não passa
 *     por sucesso.
 */
export function registerCardCreateCommand(cardCommand: Command): void {
  const command = cardCommand
    .command("create")
    .description(
      "MUTAÇÃO: cria card a partir de payload JSON — 1 card (--payload) ou LOTE (--payload-dir/--payloads) com throttle, retry em 429 e resumo por payload"
    )
    .option("--flow-id <id>", "1 passo: fluxo do card novo (com --set/--values-json, sem arquivo)")
    .option("--payload <path>", "AVANÇADO: caminho do JSON de payload (1 card)")
    .option(
      "--payload-dir <dir>",
      `LOTE: diretório com arquivos .json, um por card (ordem alfanumérica, máx ${BATCH_MAX_PAYLOADS})`
    )
    .option("--payloads <paths>", "LOTE: caminhos .json separados por vírgula")
    .option("--validate-fields", "Valida values contra fields do flow antes de mutar (inclui obrigatórios)")
    .option("--dry-run", "Exibe payload resolvido e validação (ou o plano do lote) sem executar a mutação")
    .option("--full", "Devolve o envelope completo (raw + summary). Default: só {cardId, stepId, createdAt}")
    .option(
      "--rps <n>",
      `LOTE: requisições por segundo (default ${DEFAULT_WRITE_RPS}; teto do backend em escrita: ${BACKEND_WRITE_RPS_LIMIT}/s, e estourar bloqueia a chave por ~5 min)`
    )
    .option(
      "--max-retries <n>",
      `Tentativas adicionais por card em 429 (default ${DEFAULT_MAX_RETRIES}). 5xx/timeout NÃO são repetidos: create não é idempotente`
    )
  addInlineValueOptions(command, "1 card");
  command.action(
      createCommandAction(async ({ kit, ensureAuth }, options: CardCreateOptions) => {
        const inline = parseInlineValues(options);
        const noSource = options.payload === undefined && options.payloadDir === undefined && options.payloads === undefined;
        if (noSource && (inline !== undefined || options.flowId !== undefined)) {
          return runInlineCreate(kit, ensureAuth, options, inline ?? {});
        }
        if (inline && !noSource && options.payload === undefined) {
          throw new CangeCliUsageError("--set/--values-json valem para 1 card (com --payload ou --flow-id), não para o lote.");
        }
        const { batch, sources } = await resolveSources(options);
        const rps = parseRps(options.rps);
        const maxRetries = parseMaxRetries(options.maxRetries);

        if (batch && options.full) {
          throw new CangeCliUsageError(
            "--full não é aceito em lote (N envelopes com `raw` inundam o contexto). Rode o card específico com --payload --full."
          );
        }

        // Pré-voo: TODOS os payloads são lidos e validados ANTES de qualquer
        // mutação. Payload quebrado no meio do lote viraria exatamente o que
        // este comando existe para evitar — lote parcial.
        const items = await loadItems(kit, sources, {
          validateFields: options.validateFields === true,
          ensureAuth: authenticateOnce(kit, ensureAuth),
          dryRun: options.dryRun === true,
          ...(inline ? { inline } : {})
        });

        if (options.dryRun) {
          if (!batch) {
            const item = items[0]!;
            if (item.validation) {
              return withExitCode(
                { ...createDryRunResult(item.payload), validation: item.validation },
                item.validation.valid ? EXIT_CODES.SUCCESS : EXIT_CODES.USAGE
              );
            }
            return createDryRunResult(item.payload);
          }
          return createDryRunResult({
            batch: true,
            requested: items.length,
            rps,
            maxRetries,
            payloads: items.map((item) => ({
              payload: item.source,
              flowId: item.payload.flowId,
              idForm: item.payload.idForm
            }))
          });
        }

        if (!batch) {
          const item = items[0]!;
          const { value: result } = await withRetry(
            () => kit.contracts.createCard(item.payload).catch(rethrowWithVerifyHint),
            {
              maxRetries,
              // POST /form/new-answer NÃO é idempotente e o backend não tem chave
              // de idempotência nessa rota: repetir um create que falhou por 5xx
              // ou por erro de rede (timeout = erro SEM status) pode criar o card
              // duas vezes. Só 429 é seguro repetir — o rate limiter roda ANTES do
              // handler (`applyApiRateLimit` no `ensureAuthenticated`), então é
              // comprovadamente sem efeito colateral. O resto vira falha do
              // comando, com a instrução de CONFERIR antes de reprocessar.
              shouldRetry: isRateLimitError
            }
          );
          if (options.full) {
            return result;
          }
          // A saída default é ENXUTA — o envelope completo (raw de dezenas de
          // KB) inundava o contexto do agente. --full devolve tudo.
          return {
            ...toCreatedCard(result),
            ...(item.translatedKeys.length > 0 ? { translatedKeys: item.translatedKeys } : {})
          };
        }

        const report = await runBatch(
          items,
          // Mesmo motivo do caminho de 1 card: create não é idempotente, então
          // só 429 (barrado antes do handler) pode ser repetido.
          { rps, maxRetries, shouldRetry: isRateLimitError },
          async (item) => toCreatedCard(await kit.contracts.createCard(item.payload))
        );

        const { summary, firstError } = buildBatchSummary(items, report);
        return withExitCode(
          summary,
          exitCodeForBatch({
            succeeded: summary.created,
            failed: summary.failed + summary.notAttempted,
            firstError
          })
        );
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope:
      "1 card: { cardId, stepId, flowId, createdAt } (+ summary no modo --set). LOTE: { requested, created, failed, notAttempted, cardIds, cards[], failures[]?, notAttemptedPayloads[]?, aborted?, warning? }",
    fieldsLocation:
      "LOTE: `cardIds`/`cards[].cardId` são os ÚNICOS ids que existem — NÃO deduza ids por sequência. `failures[]`/`notAttemptedPayloads[]` são os payloads a reprocessar. Exit code 5 = lote INCOMPLETO (parte criada, parte não); 0 só quando tudo passou.",
    example: 'card create --flow-id 316 --set "Título=Pedido ACME" --set "Valor=R$ 2.500,00" (lote: card create --payload-dir ./payloads/itens --validate-fields)'
  });
}

/**
 * P5: 1 card em 1 passo, sem arquivo:
 *   cange card create --flow-id 316 --set "Título=Pedido ACME" --set "Valor=R$ 2.500,00"
 */
async function runInlineCreate(
  kit: CangeAgentKit,
  ensureAuth: () => Promise<unknown>,
  options: CardCreateOptions,
  inline: Record<string, unknown>
): Promise<unknown> {
  if (options.flowId === undefined) {
    throw new CangeCliUsageError('Informe o fluxo: `cange card create --flow-id <id> --set "Campo=valor"`.');
  }
  if (options.payloadDir !== undefined || options.payloads !== undefined) {
    throw new CangeCliUsageError("--set/--values-json valem para 1 card; o lote usa --payload-dir/--payloads.");
  }
  const auth = authOnceShared(kit, ensureAuth);
  await auth();
  const ctx = await loadFlowContext(kit, options.flowId);
  const init = initScope(ctx, 0);
  if (!init) {
    throw new CangeValidationError(`O fluxo ${options.flowId} não tem formulário inicial (form_init_id).`);
  }
  const { resolved, issues } = await resolveLayers({
    layers: [inline],
    forms: [init],
    outOfScope: otherStepScopes(ctx, new Set([init.formId])),
    lookups: createWriteLookups(kit, auth)
  });
  const values = valuesOf(resolved);
  const allIssues =
    options.validateFields || options.dryRun ? [...issues, ...findMissingRequired(init, values)] : issues;
  const payload: CreateCardPayload = {
    flowId: Number(options.flowId),
    idForm: Number(init.formId),
    origin: "/cange-agent-kit",
    values
  };

  if (options.dryRun) {
    const validation = validationSummary(allIssues);
    return withExitCode(
      { ...createDryRunResult(payload), validation },
      validation.valid ? EXIT_CODES.SUCCESS : EXIT_CODES.USAGE
    );
  }
  throwIfInvalid(allIssues);

  const { value: result } = await withRetry(
    () => kit.contracts.createCard(payload).catch(rethrowWithVerifyHint),
    { maxRetries: parseMaxRetries(options.maxRetries), shouldRetry: isRateLimitError }
  );
  if (options.full) return result;
  const created = toCreatedCard(result);
  return {
    ok: true,
    ...created,
    summary:
      `Cartão ${String(created.cardId)} criado no fluxo ${ctx.flowName ?? options.flowId}` +
      (resolved.length > 0 ? `; gravou ${fieldTitles(resolved)}.` : ".")
  };
}

interface BatchItem {
  /** Caminho do payload — é o rótulo do item no resumo. */
  source: string;
  payload: CreateCardPayload;
  translatedKeys: Array<{ from: string; to: string; title?: string }>;
  /** Só no dry-run de 1 card com resolução: resultado da validação. */
  validation?: ReturnType<typeof validationSummary>;
}

interface CreatedCard {
  cardId: unknown;
  stepId: unknown;
  flowId: unknown;
  createdAt: unknown;
}

/** Resolve QUAL modo foi pedido e a lista de payloads, sem ambiguidade. */
async function resolveSources(
  options: CardCreateOptions
): Promise<{ batch: boolean; sources: string[] }> {
  const chosen = [
    options.payload !== undefined ? "--payload" : undefined,
    options.payloadDir !== undefined ? "--payload-dir" : undefined,
    options.payloads !== undefined ? "--payloads" : undefined
  ].filter((flag): flag is string => flag !== undefined);

  if (chosen.length === 0) {
    throw new CangeCliUsageError(
      "Informe --payload <arquivo.json> (1 card) ou --payload-dir <dir> / --payloads <a.json,b.json> (lote)."
    );
  }
  if (chosen.length > 1) {
    throw new CangeCliUsageError(`Use apenas uma origem de payload por vez (recebi ${chosen.join(" + ")}).`);
  }

  if (options.payload !== undefined) {
    return { batch: false, sources: [options.payload] };
  }
  if (options.payloads !== undefined) {
    const sources = options.payloads
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (sources.length === 0) {
      throw new CangeCliUsageError("--payloads vazio.");
    }
    assertBatchSize(sources.length);
    return { batch: true, sources };
  }

  return { batch: true, sources: await listJsonFiles(options.payloadDir!) };
}

function assertBatchSize(count: number): void {
  if (count > BATCH_MAX_PAYLOADS) {
    throw new CangeCliUsageError(
      `Lote aceita no máximo ${BATCH_MAX_PAYLOADS} payloads por chamada (recebi ${count}). Divida em lotes menores.`
    );
  }
}

/** Lista os .json de um diretório em ordem alfanumérica (item-2 antes de item-10). */
async function listJsonFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.resolve(process.cwd(), dir));
  } catch (error) {
    throw new CangeCliUsageError(`Não foi possível ler o diretório: ${dir}`, { cause: error });
  }

  const files = entries
    .filter((entry) => entry.toLowerCase().endsWith(".json"))
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }))
    .map((entry) => path.join(dir, entry));

  if (files.length === 0) {
    throw new CangeCliUsageError(`Nenhum arquivo .json em ${dir}.`);
  }
  assertBatchSize(files.length);
  return files;
}

interface LoadItemsOptions {
  validateFields: boolean;
  ensureAuth: () => Promise<unknown>;
  /** --set/--values-json sobre o --payload (o inline vence). */
  inline?: Record<string, unknown>;
  /** Dry-run de 1 card: validação inválida vira resultado (exit 2), não erro. */
  dryRun?: boolean;
}

/** Descoberta compartilhada pelo lote: 1 GET por flow, não 1 por payload. */
interface DiscoveryDeps {
  fields: (flowId: string | number) => ReturnType<CangeAgentKit["contracts"]["getFieldsByFlow"]>;
  formInitId: (flowId: string | number) => Promise<number | string | undefined>;
  lookups: ResolverLookups;
}

/**
 * Lê, normaliza e (opcionalmente) valida todos os payloads.
 *
 * Erros de pré-voo são COLETADOS e reportados de uma vez: com 28 payloads, um
 * erro por rodada custaria 28 turnos do agente para arrumar o lote.
 */
async function loadItems(
  kit: CangeAgentKit,
  sources: string[],
  options: LoadItemsOptions
): Promise<BatchItem[]> {
  const deps = createDiscoveryDeps(kit, options.ensureAuth);

  const items: BatchItem[] = [];
  const invalid: Array<{ payload: string; error: string; details?: unknown }> = [];

  for (const source of sources) {
    try {
      items.push(await loadItem(deps, source, options, sources.length === 1));
    } catch (error) {
      if (sources.length === 1) {
        throw error;
      }
      invalid.push({
        payload: source,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof CangeError && error.details !== undefined ? { details: error.details } : {})
      });
    }
  }

  if (invalid.length > 0) {
    throw new CangeValidationError(
      `${invalid.length} de ${sources.length} payloads do lote são inválidos. NADA foi criado — corrija os arquivos e rode de novo.`,
      { details: { invalidPayloads: invalid } }
    );
  }

  return items;
}

/**
 * Cache por flow das duas consultas de descoberta que a criação usa. Sem ele,
 * um lote de 28 cards faria 28 GETs extras — requisições que contam no MESMO
 * teto que o lote está tentando não estourar.
 */
function createDiscoveryDeps(kit: CangeAgentKit, ensureAuth: () => Promise<unknown>): DiscoveryDeps {
  const fieldsCache = new Map<string, ReturnType<CangeAgentKit["contracts"]["getFieldsByFlow"]>>();
  const flowCache = new Map<string, Promise<number | string | undefined>>();

  return {
    fields: (flowId) => {
      const key = String(flowId);
      const hit = fieldsCache.get(key) ?? kit.contracts.getFieldsByFlow({ flowId });
      fieldsCache.set(key, hit);
      return hit;
    },
    formInitId: (flowId) => {
      const key = String(flowId);
      const hit =
        flowCache.get(key) ??
        kit.contracts.getFlow({ idFlow: key }).then((flow) => flow.summary.formInitId);
      flowCache.set(key, hit);
      return hit;
    },
    lookups: createWriteLookups(kit, ensureAuth)
  };
}

/**
 * P4: chaves e valores passam pelo resolvedor único (título, id, rótulo, número
 * em texto, data dd/mm/aaaa). Payload só com hash e sem --validate-fields segue
 * direto, sem GET extra.
 */
async function loadItem(
  deps: DiscoveryDeps,
  source: string,
  options: LoadItemsOptions,
  single: boolean
): Promise<BatchItem> {
  const payloadRaw = await readPayloadFile<unknown>(source);
  const parsed = createCardPayloadSchema.safeParse(payloadRaw);
  if (!parsed.success) {
    throw new CangeValidationError(`Payload inválido para card create: ${source}`, {
      details: parsed.error.format()
    });
  }
  const payload = parsed.data;
  const merged = { ...payload.values, ...(options.inline ?? {}) };
  if (!needsFieldResolution(merged, options.validateFields || options.inline !== undefined)) {
    return { source, payload, translatedKeys: [] };
  }

  // A resolução consulta a API; em --dry-run o CLI pula a autenticação global.
  await options.ensureAuth();
  if (options.validateFields) {
    const formInitId = await deps.formInitId(payload.flowId);
    if (formInitId !== undefined && String(formInitId) !== String(payload.idForm)) {
      throw new CangeValidationError(
        "idForm divergente do formulário inicial do flow (flow.form_init_id).",
        {
          details: {
            payload: source,
            payloadIdForm: payload.idForm,
            flowFormInitId: formInitId
          }
        }
      );
    }
  }

  const { fields } = await deps.fields(payload.flowId);
  const { target, others } = scopesFromFields(fields, payload.idForm);
  const scoped = { ...target, label: "formulário inicial" };
  const { resolved, issues, passthrough } = await resolveLayers({
    layers: [payload.values, options.inline],
    forms: [scoped],
    outOfScope: others,
    lookups: deps.lookups,
    passthroughUnknown: !options.validateFields
  });
  const values = mergedValues({ resolved, passthrough });
  const allIssues = options.validateFields ? [...issues, ...findMissingRequired(scoped, values)] : issues;
  const validation = validationSummary(allIssues);
  if (!validation.valid && !(single && options.dryRun)) {
    throwIfInvalid(allIssues);
  }
  payload.values = values;
  const translatedKeys = resolved
    .filter((item) => item.key !== item.field.name)
    .map((item) => ({ from: item.key, to: item.field.name, ...(item.field.title ? { title: item.field.title } : {}) }));
  return { source, payload, translatedKeys, ...(single ? { validation } : {}) };
}

/**
 * Autenticação SOB DEMANDA e uma única vez.
 *
 * Com CANGE_EMAIL/CANGE_APIKEY, cada `ensureAuth` é um POST /session — chamar
 * por payload faria o lote gastar N logins no mesmo teto de requisições que
 * ele está tentando não estourar. Com token já em mãos, não faz nada.
 */
function authenticateOnce(kit: CangeAgentKit, ensureAuth: () => Promise<unknown>): () => Promise<unknown> {
  let pending: Promise<unknown> | undefined;
  return () => {
    if (kit.client.getAccessToken()) {
      return Promise.resolve();
    }
    pending ??= ensureAuth();
    return pending;
  };
}

function toCreatedCard(result: { summary: unknown }): CreatedCard {
  const s = result.summary as Record<string, unknown>;
  return {
    cardId: s.cardId ?? s.id_card,
    stepId: s.currentStepId ?? s.step_id,
    flowId: s.flowId ?? s.flow_id,
    createdAt: s.createdAt
  };
}

interface BatchSummary {
  requested: number;
  created: number;
  failed: number;
  notAttempted: number;
  cardIds: unknown[];
  cards: Array<{ payload: string } & CreatedCard>;
  failures?: Array<{ payload: string; attempts: number; error: string; status?: number; retryAfterSeconds?: number }>;
  notAttemptedPayloads?: string[];
  aborted?: BatchReport<CreatedCard>["aborted"];
  warning?: string;
}

/**
 * Mensagem de um create cujo desfecho é AMBÍGUO (5xx, timeout, erro de rede):
 * a requisição pode ter chegado ao backend e criado o card mesmo tendo
 * devolvido erro. Como o create não é idempotente, reprocessar às cegas
 * duplica.
 */
const VERIFY_BEFORE_RETRY =
  "CONFIRA se o card existe (card list/flow query pelo título) ANTES de reprocessar este payload — " +
  "o create não é idempotente e a requisição pode ter sido aplicada mesmo com erro.";

/**
 * O create devolveu 200 mas sem id: o kit NÃO tem como afirmar que o card
 * existe, então isso não pode contar como criado (o `cardIds` é o contrato de
 * "o que existe de verdade").
 */
const CREATED_WITHOUT_ID =
  "create respondeu 200 mas sem cardId — verifique se o card existe antes de reusar este payload";

/**
 * Resumo do lote. O contrato aqui é o antídoto do achado A4: o que existe são
 * os ids em `cardIds`; tudo que não passou aparece nomeado, e um lote
 * incompleto carrega um `warning` explícito além do exit code 5.
 *
 * Devolve junto o PRIMEIRO erro do lote (inclusive os sintéticos, como o 200
 * sem cardId) — é ele que dá a categoria do exit code quando NADA passou.
 */
function buildBatchSummary(
  items: BatchItem[],
  report: BatchReport<CreatedCard>
): { summary: BatchSummary; firstError?: unknown } {
  const cards: BatchSummary["cards"] = [];
  const failures: NonNullable<BatchSummary["failures"]> = [];
  const notAttemptedPayloads: string[] = [];
  let firstError: unknown;

  const fail = (source: string, attempts: number, error: unknown): void => {
    firstError ??= error;
    failures.push({ payload: source, attempts, ...describeError(error) });
  };

  for (const result of report.results) {
    const source = items[result.index]?.source ?? String(result.index);
    if (result.ok && result.value) {
      // 200 sem id é FALHA, não sucesso: `undefined` entrando em `cardIds`
      // vira `null` no JSON e o agente monta vínculo com um id que não existe.
      if (result.value.cardId === undefined || result.value.cardId === null) {
        // Erro sintético (não veio da API): entra no relatório com a mensagem
        // já pronta e dá a categoria do exit code quando NADA passou.
        firstError ??= new CangeApiError(`${CREATED_WITHOUT_ID}.`);
        failures.push({ payload: source, attempts: result.attempts, error: `${CREATED_WITHOUT_ID}.` });
        continue;
      }
      cards.push({ payload: source, ...result.value });
      continue;
    }
    if (!result.attempted) {
      notAttemptedPayloads.push(source);
      continue;
    }
    fail(source, result.attempts, result.error);
  }

  const pending = failures.length + notAttemptedPayloads.length;
  return {
    summary: {
      requested: items.length,
      created: cards.length,
      failed: failures.length,
      notAttempted: notAttemptedPayloads.length,
      cardIds: cards.map((card) => card.cardId),
      cards,
      ...(failures.length > 0 ? { failures } : {}),
      ...(notAttemptedPayloads.length > 0 ? { notAttemptedPayloads } : {}),
      ...(report.aborted ? { aborted: report.aborted } : {}),
      ...(pending > 0
        ? {
            warning:
              `ATENÇÃO: ${pending} de ${items.length} cards NÃO foram criados. ` +
              "Os únicos cards que existem são os de `cardIds` — NÃO deduza ids por sequência e NÃO monte vínculos/contagens com ids que não estão nessa lista. " +
              "Reprocesse os payloads de `failures`/`notAttemptedPayloads` e, se não for possível concluir, reporte a tarefa como PARCIAL."
          }
        : {})
    },
    ...(firstError !== undefined ? { firstError } : {})
  };
}

/**
 * Desfecho ambíguo = pode ter sido aplicado no backend: 5xx e erro SEM status
 * (timeout/rede). 4xx é recusa do payload e 429 é barrado antes do handler —
 * nesses dois o card comprovadamente não foi criado.
 */
function isAmbiguousWriteError(error: unknown): boolean {
  if (!(error instanceof CangeError)) {
    return false;
  }
  return error.status === undefined || error.status >= 500;
}

/** Anexa o aviso de conferência ao erro de create com desfecho ambíguo. */
function rethrowWithVerifyHint(error: unknown): never {
  if (!isAmbiguousWriteError(error) || !(error instanceof CangeError)) {
    throw error;
  }
  throw new CangeApiError(`${error.message} ${VERIFY_BEFORE_RETRY}`, {
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.endpoint !== undefined ? { endpoint: error.endpoint } : {}),
    ...(error.method !== undefined ? { method: error.method } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
    ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    cause: error
  });
}

function describeError(error: unknown): { error: string; status?: number; retryAfterSeconds?: number } {
  if (error instanceof CangeError) {
    const message = isAmbiguousWriteError(error)
      ? `${error.message} ${VERIFY_BEFORE_RETRY}`
      : error.message;
    return {
      error: message,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {})
    };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

function parseRps(raw: string | undefined): number {
  const value = parseNumberOption(raw, "--rps", DEFAULT_WRITE_RPS);
  if (value > BACKEND_WRITE_RPS_LIMIT) {
    throw new CangeCliUsageError(
      `--rps ${value} passa do teto de escrita do backend (${BACKEND_WRITE_RPS_LIMIT} req/s) — estourar bloqueia a chave por ~5 minutos.`
    );
  }
  return value;
}

function parseMaxRetries(raw: string | undefined): number {
  const value = parseNumberOption(raw, "--max-retries", DEFAULT_MAX_RETRIES, { allowZero: true });
  return Math.trunc(value);
}

function parseNumberOption(
  raw: string | undefined,
  flag: string,
  fallback: number,
  options: { allowZero?: boolean } = {}
): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  const min = options.allowZero ? 0 : Number.MIN_VALUE;
  if (!Number.isFinite(value) || value < min) {
    throw new CangeCliUsageError(
      `${flag} inválido: "${raw}" (esperado número ${options.allowZero ? ">= 0" : "> 0"}).`
    );
  }
  return value;
}
