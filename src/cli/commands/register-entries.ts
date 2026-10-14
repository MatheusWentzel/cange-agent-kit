import type { Command } from "commander";

import { CangeApiError, CangeCliUsageError } from "../../client/errors.js";
import type { RegisterEntry } from "../../contracts/types.js";
import type { NormalizedField } from "../../schemas/fields.js";
import { NO_ANSWER_FIELD_TYPES } from "../../schemas/flowV2Build.js";
import { dropEmpty, htmlToMarkdown, looksLikeHtml } from "../../utils/lean.js";
import { listOutput } from "../../utils/toon.js";
import { TRUNCATED_VALUE_MARKER, matchFieldsByKey } from "../../utils/valueResolver.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction, type CliCommandContext } from "../context.js";
import { addSearchSynonyms } from "../helpers.js";
import { parseCangeLink } from "../resource-ref.js";

interface RegisterEntriesOptions {
  idRegister?: string;
  register?: string;
  registerId?: string;
  search?: string;
  pageSize?: string;
  cursor?: string;
  fields?: string;
  entryId?: string;
}

/**
 * C4 (card #1367459): página padrão do enxuto. Ler cadastro custava ~9 mil tokens por
 * vez em produção (o `raw` inteiro ia junto das entradas, e todas as entradas de uma vez).
 */
export const REGISTER_ENTRIES_DEFAULT_PAGE = 20;
/** Teto do valor de um campo de entrada no enxuto (rich text, observações). */
const ENTRY_VALUE_CAP = 600;

/** Campos que não guardam valor (título, divisor, botão, descrição): fora de `fieldTitles` e de `entry`. */
const NO_VALUE_TYPES: ReadonlySet<string> = new Set(NO_ANSWER_FIELD_TYPES);

function readableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readableValue);
  if (typeof value !== "string") return value;
  return looksLikeHtml(value) ? htmlToMarkdown(value) : value;
}

/** O valor inteiro de um campo cortado: `--entry-id <id> --fields "<título>"` (ou o id do campo). */
function cutHint(entryId: unknown, title: string): string {
  const key = /[",]/.test(title) ? "<campo>" : title;
  const id = entryId === undefined || entryId === null ? "<id>" : String(entryId);
  return `cange register entries --entry-id ${id} --fields "${key}"`;
}

function cutEntryValue(value: unknown, entryId: unknown, title: string): unknown {
  if (Array.isArray(value)) return value.map((item) => cutEntryValue(item, entryId, title));
  const text = readableValue(value);
  if (typeof text !== "string" || text.length <= ENTRY_VALUE_CAP) return text;
  return `${text.slice(0, ENTRY_VALUE_CAP)}${TRUNCATED_VALUE_MARKER} o valor inteiro em ${cutHint(entryId, title)})`;
}

function leanEntry(entry: RegisterEntry): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [label, value] of Object.entries(entry.fields ?? {})) {
    fields[label] = cutEntryValue(value, entry.id, label);
  }
  return { id: entry.id, title: entry.title, fields };
}

function fieldLabel(field: NormalizedField): string {
  return field.title ?? field.name;
}

/** Campos que guardam valor, na ordem do formulário (o back devolve pelo `index`), sem repetir o título. */
function valueFields(fields: NormalizedField[]): NormalizedField[] {
  const seen = new Set<string>();
  const out: NormalizedField[] = [];
  for (const field of fields) {
    if (NO_VALUE_TYPES.has(field.type)) continue;
    const label = fieldLabel(field);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(field);
  }
  return out;
}

function splitList(text: string | undefined): string[] {
  return (text ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** `--fields`: título (sem acento e caixa), id ou hash, como no `card read --fields`. Títulos reais, na ordem pedida. */
function resolveRequestedTitles(keys: string[], fields: NormalizedField[], registerId: string): string[] {
  const candidates = valueFields(fields);
  const titles: string[] = [];
  const unknown: string[] = [];
  for (const key of keys) {
    const hits = matchFieldsByKey(key, candidates);
    if (hits.length === 0) {
      unknown.push(key);
      continue;
    }
    for (const hit of hits) {
      const title = fieldLabel(hit);
      if (!titles.includes(title)) titles.push(title);
    }
  }
  if (unknown.length > 0) {
    const names = candidates.map(fieldLabel).join(", ");
    throw new CangeCliUsageError(
      `Campo ${unknown.map((key) => `"${key}"`).join(", ")} não existe no cadastro ${registerId} (campos: ${names || "nenhum"}).`
    );
  }
  return titles;
}

/** Exatamente os títulos pedidos, na ordem, com o valor ou null (vazio). */
function pickFields(entry: RegisterEntry, titles: string[], cut: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const title of titles) {
    const value = entry.fields?.[title];
    if (value === undefined || value === null || value === "") {
      out[title] = null;
      continue;
    }
    out[title] = cut ? cutEntryValue(value, entry.id, title) : readableValue(value);
  }
  return out;
}

/** Os campos do cadastro (1 GET). Falhou = `undefined`: a leitura segue sem `fieldTitles`. */
async function loadRegisterFields(
  kit: CliCommandContext["kit"],
  registerId: string
): Promise<NormalizedField[] | undefined> {
  try {
    return (await kit.contracts.getFieldsByRegister({ registerId })).fields;
  } catch {
    return undefined;
  }
}

/**
 * O valor de `--entry-id`: número (`6507`, `#6507`) ou o link da entrada, a menção do
 * chat `cange://register/<cadastro>/entry/<entrada>` ou o link da tela
 * `…/register/<hash>/register/<entrada>`. O link com o id numérico do cadastro também
 * diz o cadastro (o kit não precisa localizar a entrada).
 */
export function parseEntryRef(raw: string): { entryId: string; registerId?: string } {
  const text = String(raw ?? "").trim();
  const link = parseCangeLink(text);
  if (link) {
    if (!link.entryId) {
      throw new CangeCliUsageError(
        "--entry-id: o link não traz uma entrada de cadastro (cange://register/<cadastro>/entry/<entrada> ou …/register/<hash>/register/<entrada>). Use o número da entrada (o id de cada item em cange register entries)."
      );
    }
    return { entryId: link.entryId, ...(link.register?.kind === "id" ? { registerId: link.register.id } : {}) };
  }
  const value = text.replace(/^#/, "");
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CangeCliUsageError(
      `--entry-id precisa do número da entrada (recebido: ${text || "vazio"}). O número é o id de cada item em cange register entries.`
    );
  }
  return { entryId: value };
}

export function registerRegisterEntriesCommand(registerCommand: Command): void {
  const command = registerCommand
    .command("entries")
    // v9 (run 1131): o agente chamou `register entry` e tomou "Comando não existe".
    .alias("entry")
    .description("Lê as entradas de um cadastro (detecta a engine v1/v2 e roteia automaticamente)")
    .option("--register-id <id>", "ID do cadastro (register); aceita também o link do Cange ou o hash")
    .option("--register <id>", "Alias de --register-id")
    // Alias legado: o resto do CLI usa --register-id; mantido por compatibilidade.
    .option("--id-register <id>", "ID do cadastro (alias legado de --register-id)")
    .option("--search <text>", "Filtra as entradas por texto (--q é sinônimo)")
    .option(
      "--fields <campos>",
      'Só estes campos, pelo TÍTULO (sem diferença de maiúscula/acento), id ou hash, separados por vírgula: --fields "Razão social,CNPJ/CPF". Campo vazio sai como null'
    )
    .option(
      "--entry-id <id>",
      "Uma entrada só, pelo número ou pelo link (cange://register/<cadastro>/entry/<entrada>), com TODOS os campos (vazio = null). O cadastro é descoberto pela entrada; --register-id é opcional"
    )
    .option(
      "--page-size <n>",
      `Entradas por página (enxuto: padrão ${REGISTER_ENTRIES_DEFAULT_PAGE}; engine v2 tem teto 200)`
    )
    .option("--cursor <cursor>", "Página seguinte: o `--cursor` que veio em `next` na chamada anterior")
    .action(
      createCommandAction(async ({ kit, profile }, options: RegisterEntriesOptions) => {
        options.idRegister = options.registerId ?? options.register ?? options.idRegister;
        if (options.entryId !== undefined) {
          return readOneEntry(kit, profile, options);
        }
        if (!options.idRegister) {
          throw new CangeCliUsageError(
            "Informe --register-id <id> (o id aparece em cange my-registers; o link do Cange também serve) ou --entry-id <id> para uma entrada só."
          );
        }
        const explicitPageSize = options.pageSize !== undefined ? Number(options.pageSize) : undefined;
        if (explicitPageSize !== undefined && (!Number.isInteger(explicitPageSize) || explicitPageSize <= 0)) {
          throw new CangeCliUsageError("--page-size deve ser um inteiro positivo.");
        }
        const requestedKeys = splitList(options.fields);
        if (profile === "full" && requestedKeys.length === 0) {
          return kit.contracts.getRegisterEntries({
            registerId: options.idRegister,
            search: options.search,
            pageSize: explicitPageSize,
            cursor: options.cursor
          });
        }

        // Enxuto: sem `raw`, página de 20, valor longo cortado e o comando da página seguinte.
        // v9: os campos do cadastro (1 GET, que a engine v2 reaproveita) dão `fieldTitles`.
        let registerFields = await loadRegisterFields(kit, options.idRegister);
        if (requestedKeys.length > 0 && registerFields === undefined) {
          // Sem a lista não dá para saber o título pedido: lê de novo e, se falhar, sai o erro real.
          registerFields = (await kit.contracts.getFieldsByRegister({ registerId: options.idRegister })).fields;
        }
        const requestedTitles =
          requestedKeys.length > 0 ? resolveRequestedTitles(requestedKeys, registerFields ?? [], options.idRegister) : undefined;

        const pageSize = explicitPageSize ?? REGISTER_ENTRIES_DEFAULT_PAGE;
        const isOffset = options.cursor === undefined || /^\d+$/.test(options.cursor);
        const result = await kit.contracts.getRegisterEntries({
          registerId: options.idRegister,
          search: options.search,
          pageSize,
          // Cursor numérico é o deslocamento da v1 (lista inteira); o resto é cursor da v2.
          cursor: isOffset ? undefined : options.cursor,
          fields: registerFields
        });

        let entries = result.entries;
        let total: number | undefined;
        let nextCursor: string | undefined;
        if (result.engine === "v1") {
          const offset = options.cursor !== undefined && isOffset ? Number(options.cursor) : 0;
          total = entries.length;
          entries = entries.slice(offset, offset + pageSize);
          if (offset + pageSize < total) nextCursor = String(offset + pageSize);
        } else {
          total = result.executionStats?.totalCount;
          nextCursor = result.pageInfo.hasMore ? result.pageInfo.nextCursor : undefined;
        }

        const next = nextCursor
          ? [
              "cange register entries",
              `--register-id ${options.idRegister}`,
              ...(options.search ? [`--search ${JSON.stringify(options.search)}`] : []),
              ...(options.fields ? [`--fields ${JSON.stringify(options.fields)}`] : []),
              ...(explicitPageSize !== undefined ? [`--page-size ${explicitPageSize}`] : []),
              `--cursor ${nextCursor}`
            ].join(" ")
          : undefined;

        const envelope: Record<string, unknown> = dropEmpty({
          registerId: Number(options.idRegister),
          engine: result.engine,
          total,
          count: entries.length,
          next,
          fieldTitles: registerFields ? valueFields(registerFields).map(fieldLabel) : undefined
        });
        envelope.entries = requestedTitles
          ? entries.map((entry) => ({
              ...dropEmpty({ id: entry.id, title: entry.title }),
              // null = vazio: com --fields cada entrada traz exatamente os títulos pedidos.
              fields: pickFields(entry, requestedTitles, true)
            }))
          : (dropEmpty({ entries: entries.map(leanEntry) }) as { entries: unknown[] }).entries;
        return listOutput(envelope, "entries");
      })
    );
  addSearchSynonyms(command, "search");

  annotateCommand(command, {
    envelope:
      `Enxuto (padrão): { registerId, engine, total?, count, next? (comando pronto da página seguinte), fieldTitles (todos os campos do cadastro, na ordem do formulário), entries[{id, title, fields: {<título do campo>: valor}}] } com ${REGISTER_ENTRIES_DEFAULT_PAGE} por página e valor acima de ${ENTRY_VALUE_CAP} caracteres cortado. ` +
      "Campo que está em fieldTitles e não aparece na entrada está VAZIO nela. " +
      "--fields \"<títulos>\": cada entrada traz exatamente esses campos, na ordem, com null quando vazio. " +
      "--entry-id <id>: { registerId, entry: {id, title, fields: {<cada campo do cadastro>: valor ou null}} } (com --fields, só esses e sem corte). " +
      "Com --full (sem --fields/--entry-id): { raw, engine, entries, pageInfo, executionStats? } (formato de antes)",
    fieldsLocation:
      "o id de cada item em `entries` é o id da entrada (form answer); `register entry` é o mesmo comando",
    example:
      'register entries --register-id 175 --search "ACME"  ·  register entries --entry-id 6507 --fields "CNPJ/CPF"'
  });
}

/**
 * v9 (run 1131): uma entrada pelo número, com TODOS os campos (vazio = null), para o
 * agente não confundir "campo vazio" com "campo que não veio". O cadastro sai da
 * própria entrada; os valores vêm pela leitura do cadastro (mesmo acesso da lista).
 */
async function readOneEntry(
  kit: CliCommandContext["kit"],
  profile: CliCommandContext["profile"],
  options: RegisterEntriesOptions
): Promise<unknown> {
  if (options.search !== undefined) {
    throw new CangeCliUsageError("Use --entry-id sozinho ou --search, não os dois.");
  }
  if (options.cursor !== undefined) {
    throw new CangeCliUsageError("Use --entry-id sozinho ou --cursor, não os dois.");
  }
  const entryRef = parseEntryRef(options.entryId ?? "");
  const entryId = entryRef.entryId;
  // A menção do chat traz o cadastro: vale como --register-id quando ele não veio.
  const given = options.idRegister ?? entryRef.registerId;
  // O pedido de acesso (hint do 404) usa o cadastro do link.
  if (options.idRegister === undefined && entryRef.registerId !== undefined) options.registerId = entryRef.registerId;

  let registerId = given;
  if (registerId === undefined) {
    const location = await kit.contracts.locateRegisterEntry({ entryId });
    if (!location) {
      throw new CangeApiError(`A entrada ${entryId} não existe ou foi apagada.`, {
        status: 404,
        hint: "Confira o número em cange register entries --register-id <id> --search <texto>."
      });
    }
    if (location.registerId === undefined) {
      throw new CangeCliUsageError(
        `A resposta ${entryId} não é entrada de cadastro${location.cardId ? ` (é do cartão ${location.cardId}: cange card read --card-id ${location.cardId})` : ""}.`
      );
    }
    registerId = String(location.registerId);
    // O pedido de acesso (hint do 404) usa o cadastro descoberto.
    options.registerId = registerId;
  }

  let registerFields = await loadRegisterFields(kit, registerId);
  const requestedKeys = splitList(options.fields);
  if (requestedKeys.length > 0 && registerFields === undefined) {
    registerFields = (await kit.contracts.getFieldsByRegister({ registerId })).fields;
  }
  const requestedTitles =
    requestedKeys.length > 0 ? resolveRequestedTitles(requestedKeys, registerFields ?? [], registerId) : undefined;

  const result = await kit.contracts.getRegisterEntry({ registerId, entryId, fields: registerFields });
  if (!result.entry) {
    if (given !== undefined) {
      // O cadastro informado não tem a entrada: é de outro (erro de uso) ou não existe.
      const location = await kit.contracts.locateRegisterEntry({ entryId }).catch(() => undefined);
      if (location?.registerId !== undefined && String(location.registerId) !== String(given)) {
        throw new CangeCliUsageError(`A entrada ${entryId} é do cadastro ${location.registerId}, não do ${given}.`);
      }
    }
    throw new CangeApiError(`A entrada ${entryId} não está no cadastro ${registerId} (ou foi apagada).`, {
      status: 404,
      hint: `Confira o número em cange register entries --register-id ${registerId} --search <texto>.`
    });
  }

  const entry = result.entry;
  const titles = requestedTitles ?? (registerFields ? valueFields(registerFields).map(fieldLabel) : undefined);
  const fields = titles
    ? pickFields(entry, titles, requestedTitles === undefined && profile !== "full")
    : Object.fromEntries(
        Object.entries(entry.fields ?? {}).map(([title, value]) => [
          title,
          profile === "full" ? readableValue(value) : cutEntryValue(value, entry.id, title)
        ])
      );
  const out: Record<string, unknown> = {
    registerId: Number(registerId),
    entry: { ...dropEmpty({ id: entry.id, title: entry.title }), fields }
  };
  if (profile === "full") {
    out.engine = result.engine;
    out.raw = result.raw;
  }
  return out;
}
