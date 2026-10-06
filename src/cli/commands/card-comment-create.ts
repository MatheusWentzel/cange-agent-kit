import type { Command } from "commander";

import { CangeCliUsageError, CangeValidationError } from "../../client/errors.js";
import type { CangeAgentKit } from "../../index.js";
import { createCardCommentPayloadSchema } from "../../schemas/comments.js";
import { createDryRunResult } from "../../utils/dryRun.js";
import { normalizeText, type CompanyUser } from "../../utils/valueResolver.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";
import { readPayloadFile } from "../helpers.js";
import { authOnce } from "../write-support.js";

interface CommentCreateOptions {
  payload?: string;
  cardId?: string;
  flowId?: string;
  text?: string;
  mention?: string[];
  dryRun?: boolean;
}

function collectRepeatable(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function registerCardCommentCreateCommand(commentCommand: Command): void {
  const command = commentCommand
    .command("create")
    .description(
      'MUTAÇÃO: cria comentário em um card (1 passo: --card-id + --text, menções com --mention). Ex.: comment create --card-id 123 --text "Feito" --mention ana@empresa.com'
    )
    .option("--card-id <id>", "Cartão (número ou link)")
    .option("--text <texto>", "Texto do comentário (markdown)")
    .option(
      "--mention <usuario>",
      "Menciona e notifica (repetível): id, e-mail ou nome do usuário. Vira @[Nome](id) no texto e entra em `mentions`",
      collectRepeatable
    )
    .option("--payload <path>", "AVANÇADO: arquivo JSON {cardId, flowId?, description, mentions?}")
    .option(
      "--flow-id <id>",
      "ID do flow do card (opcional). Precedência: --flow-id > flowId no payload > CANGE_CARD_FLOW_ID do ambiente. Deixe em branco quando rodando pelo runner (ele injeta o flow do card)."
    )
    .option("--dry-run", "Exibe o payload resolvido (menções já no formato do back) sem executar a mutação")
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: CommentCreateOptions) => {
        const fromFile = options.payload ? await readPayloadFile<Record<string, unknown>>(options.payload) : {};
        const inlineMode = options.payload === undefined;
        if (inlineMode && (options.cardId === undefined || options.text === undefined)) {
          throw new CangeCliUsageError(
            'Informe o cartão e o texto: `cange comment create --card-id <id> --text "<texto>" [--mention <id|e-mail|nome>]`.'
          );
        }

        const merged: Record<string, unknown> = {
          ...fromFile,
          ...(options.cardId !== undefined ? { cardId: Number(options.cardId) } : {}),
          ...(options.text !== undefined ? { description: options.text } : {})
        };
        const parsed = createCardCommentPayloadSchema.safeParse(merged);
        if (!parsed.success) {
          throw new CangeValidationError("Payload inválido para comment create.", {
            details: parsed.error.format()
          });
        }

        // --flow-id explícito vence o flowId do payload; se nenhum vier, o contrato resolve
        // de CANGE_CARD_FLOW_ID (injetado pelo runner). Não precisa saber o fluxo no payload.
        const input = {
          ...parsed.data,
          ...(options.flowId ? { flowId: Number(options.flowId) } : {})
        };

        let mentioned: CompanyUser[] = [];
        if (options.mention && options.mention.length > 0) {
          await authOnce(kit, ensureAuth)();
          mentioned = await resolveMentions(kit, options.mention);
          const withMarkup = applyMentionMarkup(input.description, mentioned);
          input.description = withMarkup;
          input.mentions = Array.from(new Set([...(input.mentions ?? []), ...mentioned.map((user) => user.id)]));
        }

        if (options.dryRun) {
          return createDryRunResult(input);
        }

        const result = await kit.contracts.createCardComment(input);
        if (!inlineMode) {
          return result;
        }
        const raw = (result.raw ?? {}) as Record<string, unknown>;
        const names = mentioned.map((user) => user.name ?? `usuário ${user.id}`);
        return {
          ok: true,
          commentId: raw.id_card_comment ?? raw.id,
          cardId: input.cardId,
          ...(input.mentions && input.mentions.length > 0 ? { mentions: input.mentions } : {}),
          summary:
            `Comentário criado no cartão ${input.cardId}` + (names.length > 0 ? ` mencionando ${names.join(", ")}.` : ".")
        };
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope: "{ ok, commentId, cardId, mentions?, summary } (modo --text). Com --payload: { raw }",
    fieldsLocation:
      "Menção: --mention <id|e-mail|nome> notifica a pessoa (mentions) E marca @[Nome](id) no texto. Se o texto já tem @Nome, ele vira a marcação.",
    example: 'comment create --card-id 1234 --text "Proposta enviada, @Ana confere?" --mention "Ana Souza"'
  });
}

/** id, e-mail ou nome → usuário da empresa (único). Erro de uso listando candidatos. */
export async function resolveMentions(kit: CangeAgentKit, refs: string[]): Promise<CompanyUser[]> {
  let users: CompanyUser[] | undefined;
  try {
    users = (await kit.contracts.listCompanyUsers()).users;
  } catch {
    users = undefined;
  }

  const out: CompanyUser[] = [];
  const problems: string[] = [];
  for (const ref of refs) {
    const text = ref.trim().replace(/^@/, "");
    const asId = /^#?\d+$/.test(text) ? Number(text.replace(/^#/, "")) : undefined;
    if (!users) {
      if (asId !== undefined) {
        out.push({ id: asId });
        continue;
      }
      problems.push(`não deu para buscar "${text}" (lista de usuários indisponível): use o id`);
      continue;
    }
    let pool: CompanyUser[];
    if (asId !== undefined) {
      pool = users.filter((user) => user.id === asId);
      if (pool.length === 0) {
        problems.push(`nenhum usuário ativo com id ${asId}`);
        continue;
      }
    } else if (text.includes("@")) {
      pool = users.filter((user) => user.email?.toLowerCase() === text.toLowerCase());
    } else {
      const wanted = normalizeText(text);
      const exact = users.filter((user) => user.name && normalizeText(user.name) === wanted);
      pool = exact.length > 0 ? exact : users.filter((user) => user.name && normalizeText(user.name).includes(wanted));
    }
    if (pool.length === 1) {
      if (!out.some((user) => user.id === pool[0]!.id)) out.push(pool[0]!);
      continue;
    }
    problems.push(
      pool.length === 0
        ? `nenhum usuário "${text}"`
        : `"${text}" é ambíguo: ${pool
            .slice(0, 8)
            .map((user) => `${user.name ?? "?"} (id ${user.id}${user.email ? `, ${user.email}` : ""})`)
            .join(", ")}`
    );
  }
  if (problems.length > 0) {
    throw new CangeCliUsageError(`Nada foi gravado. Menção: ${problems.join("; ")}.`);
  }
  return out;
}

/**
 * Marca cada mencionado no texto no formato da tela (`@[Nome](id)`), que o back
 * também lê para notificar. Se o texto já tem `@Nome`, ele vira a marcação; se
 * não tem, a marcação entra no começo. Marcação já presente não duplica.
 */
export function applyMentionMarkup(description: string, users: CompanyUser[]): string {
  let text = description;
  const prefix: string[] = [];
  for (const user of users) {
    if (new RegExp(`@\\[[^\\]]*\\]\\(${user.id}\\)`).test(text)) continue;
    const display = user.name ?? user.email ?? `usuário ${user.id}`;
    const markup = `@[${display}](${user.id})`;
    const candidates = [user.name, user.email, user.name?.split(/\s+/)[0]].filter(
      (item): item is string => typeof item === "string" && item.length > 0
    );
    let replaced = false;
    for (const candidate of candidates) {
      const pattern = new RegExp(`@${escapeRegExp(candidate)}(?![\\p{L}\\p{N}])`, "iu");
      if (pattern.test(text)) {
        text = text.replace(pattern, markup);
        replaced = true;
        break;
      }
    }
    if (!replaced) prefix.push(markup);
  }
  return prefix.length > 0 ? `${prefix.join(" ")} ${text}` : text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
