import { readFile } from "node:fs/promises";
import type { Command } from "commander";

import { CangeValidationError } from "../../client/errors.js";
import type { ArtifactOwner } from "../../contracts/artifacts.js";
import { publishArtifactInputSchema } from "../../schemas/artifacts.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction, withExitCode } from "../context.js";
import { envCardId, envChatSessionId } from "../env-defaults.js";
import { EXIT_CODES } from "../exit-codes.js";

interface ArtifactPublishOptions {
  cardId?: string;
  card?: string;
  sessionId?: string;
  type: string;
  title: string;
  file: string;
  accent?: string;
  density?: string;
  variant?: string;
  full?: boolean;
  dryRun?: boolean;
}

/**
 * Regras do HTML do artefato (rodada 3, 01/10): CSS liberado e saneado no back.
 * Fonte única do texto que vai no help do `publish` e do `get`.
 */
export const ARTIFACT_HTML_RULES =
  "O --file é HTML com o SEU layout e CSS: pode usar <style> (no <head> ou no corpo) e style=\"\" à vontade " +
  "(grid, cards, cores, sombras, espaçamento, backdrop-filter). O tema oficial é a BASE e o seu CSS vence ele: " +
  "tokens em :root (--accent, --ink, --ink-soft, --muted, --bg, --surface, --border, --radius, --space, --font) e " +
  "classes prontas (.kpi-row/.kpi/.kpi-label/.kpi-value, .callout, .badge-ok|warn|bad, .table-wrap, .num, .muted). " +
  "Proibido (cai com aviso em `warnings`): script, url() externo (só data:image/png|jpeg|gif|webp), @import, " +
  "@font-face e fonte web, image-set()/image()/element()/paint()/cross-fade(); use fontes do sistema. " +
  "Feche o HTML com <!-- /artifact -->. Confira antes com --dry-run (mostra o que seria removido, sem publicar).";

/** Regra de cada campo do publish, como a flag que o agente escreve (KR-02). */
const PUBLISH_FIELD_RULES: Record<string, string> = {
  type: "--type precisa ter de 1 a 40 caracteres",
  title: "--title precisa ter de 1 a 255 caracteres",
  html: "o arquivo do --file está vazio",
  accent: "--accent aceita no máximo 24 caracteres",
  density: "--density aceita no máximo 16 caracteres",
  variant: "--variant aceita no máximo 24 caracteres",
  cardId: "informe um dono só: --card-id (cartão) ou --session-id (conversa)",
  sessionId: "informe um dono só: --card-id (cartão) ou --session-id (conversa)"
};

/** Problemas do `publishArtifactInputSchema` em texto de flag (sem repetir a mesma regra). */
export function describePublishInputIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  const lines = issues.map((issue) => {
    const key = String(issue.path[0] ?? "");
    return PUBLISH_FIELD_RULES[key] ?? `${key || "comando"}: ${issue.message}`;
  });
  return `${[...new Set(lines)].join("; ")}.`;
}

function positiveIntOrThrow(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CangeValidationError(`${flag} deve ser um inteiro positivo (recebido: ${raw}).`);
  }
  return value;
}

/**
 * Resolve o DONO do artefato: cartão ou conversa (agent_session), nunca os dois.
 * Precedência (flag explícita > env, como nos outros defaults do runner):
 *   1. `--card-id`/`--card` → cartão; `--session-id` → conversa (os dois juntos = erro);
 *   2. sem flag: RUNNER_CARD_ID/CANGE_CARD_ID → cartão (run de automação, ou
 *      chat com cartão em foco: continua publicando no cartão);
 *   3. sem cartão: RUNNER_CHAT_SESSION_ID → conversa (chat sem cartão);
 *   (2 e 3 leem só o ambiente do processo, nunca o `.env` do diretório.)
 *   4. nada disso → erro de validação.
 */
export function resolveArtifactOwner(
  options: Pick<ArtifactPublishOptions, "cardId" | "card" | "sessionId">
): ArtifactOwner {
  const flagCard = options.cardId ?? options.card;
  const flagSession = options.sessionId;
  if (flagCard !== undefined && flagSession !== undefined) {
    throw new CangeValidationError(
      "Use --card-id OU --session-id, não os dois: o artefato pertence a um cartão ou a uma conversa."
    );
  }
  if (flagCard !== undefined) return { cardId: positiveIntOrThrow(flagCard, "--card-id") };
  if (flagSession !== undefined) return { sessionId: positiveIntOrThrow(flagSession, "--session-id") };

  // Dono pelo ambiente: só o do PROCESSO (o que o runner injeta). O `.env` do
  // diretório é carregado antes (createCangeAgentKit) e, no chat sem cartão, um
  // `.env` no workspace do agente recolocaria um cartão que o runner tirou.
  const envCard = envCardId({ processOnly: true });
  if (envCard !== undefined) return { cardId: Number(envCard) };
  const envSession = envChatSessionId();
  if (envSession !== undefined) return { sessionId: Number(envSession) };

  throw new CangeValidationError(
    "Informe o dono do artefato: --card-id <id> (cartão; aceita --card como alias) ou --session-id <id> (conversa do agente). " +
      "Em automação, o RUNNER_CARD_ID do ambiente é o padrão; num chat sem cartão, o RUNNER_CHAT_SESSION_ID."
  );
}

export function registerArtifactPublishCommand(artifactCommand: Command): void {
  const command = artifactCommand
    .command("publish")
    .description(
      "MUTAÇÃO: publica/atualiza um artefato HTML (com CSS próprio) num card ou numa conversa do agente (nova versão, mesma URL); com --dry-run só confere"
    )
    // `--card-id` é a flag canônica; `--card` é alias tolerado (LLMs erram pra
    // ele com frequência — caso real do run 96; aceitar é mais barato que o retry).
    .option("--card-id <id>", "ID do card")
    .option("--card <id>", "Alias de --card-id")
    .option(
      "--session-id <id>",
      "ID da conversa do agente (artefato de conversa, sem cartão). Não combina com --card-id"
    )
    .requiredOption("--type <type>", "Tipo do artefato (ex.: mapa-cotacao, one-pager)")
    .requiredOption("--title <title>", "Título do artefato")
    .requiredOption("--file <path>", "Caminho do arquivo HTML (aceita <style> e style=\"\"; sem script nem recurso externo)")
    .option("--accent <accent>", "Cor de destaque: orange|purple|red|blue|green|teal|slate|amber|rose|indigo")
    .option("--density <density>", "Densidade: default|compact")
    .option("--variant <variant>", "Variante de tema: editorial (documento formal)")
    .option("--full", "Devolve o envelope completo. Default: {artifactId, slug, version}")
    .option(
      "--dry-run",
      "Confere o HTML/CSS no Cange SEM publicar: diz se passaria e o que o saneador removeria (leitura)"
    )
    // Hábito das outras escritas (`--dry-run --validate-fields`): aqui não há
    // campos, a conferência é o próprio --dry-run. Aceito sem efeito para não
    // queimar um turno com "unknown option" (mesma lógica do alias --card).
    .option("--validate-fields", "Sem efeito no artefato (a conferência é o --dry-run); aceito por compatibilidade")
    .action(
      createCommandAction(async ({ kit, ensureAuth }, options: ArtifactPublishOptions) => {
        const owner = resolveArtifactOwner(options);

        let html: string;
        try {
          html = await readFile(options.file, "utf8");
        } catch (error) {
          throw new CangeValidationError(
            `Não foi possível ler o arquivo HTML em ${options.file}: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        if (options.dryRun) {
          // KR-02: as MESMAS regras locais do publish real (type 1..40, title
          // 1..255, accent/variant ≤24, density ≤16), antes do /validate: o
          // dry-run nunca diz "passaria" para um comando que o kit recusa.
          const local = publishArtifactInputSchema.safeParse({
            ...owner,
            type: options.type,
            title: options.title,
            html,
            ...(options.accent ? { accent: options.accent } : {}),
            ...(options.density ? { density: options.density } : {}),
            ...(options.variant ? { variant: options.variant } : {})
          });
          if (!local.success) {
            return withExitCode(
              {
                dryRun: true,
                executed: false,
                ok: false,
                error: describePublishInputIssues(local.error.issues),
                warnings: [],
                type: options.type,
                title: options.title,
                ...(owner.sessionId !== undefined ? { sessionId: owner.sessionId } : { cardId: owner.cardId }),
                note: "Nada foi publicado. NÃO passaria: o kit recusa estas flags antes de chamar o Cange. Corrija e confira de novo."
              },
              EXIT_CODES.USAGE
            );
          }
          // O wrapper pula a autenticação em --dry-run (premissa de que dry-run
          // não faz I/O), mas a conferência do artefato é do BACK (o mesmo
          // saneador do publish): autentica aqui. No gate do agente a rota é
          // leitura (não pede grant nem aprovação).
          await ensureAuth();
          const check = await kit.contracts.validateArtifact({ html });
          const value = {
            dryRun: true,
            executed: false,
            ok: check.ok,
            ...(check.error ? { error: check.error } : {}),
            warnings: check.warnings,
            normalizations: check.normalizations,
            rawBytes: check.rawBytes,
            htmlBytes: check.htmlBytes,
            cssBytes: check.cssBytes,
            maxCssBytes: check.maxCssBytes,
            type: options.type,
            title: options.title,
            ...(owner.sessionId !== undefined ? { sessionId: owner.sessionId } : { cardId: owner.cardId }),
            note: check.ok
              ? check.warnings.length > 0
                ? "Nada foi publicado. Passaria, mas o que está em warnings seria REMOVIDO: corrija e confira de novo, ou publique sabendo disso."
                : "Nada foi publicado. Passaria sem remoções: rode o mesmo comando sem --dry-run, com o MESMO arquivo."
              : "Nada foi publicado. NÃO passaria: corrija o arquivo (grave um novo) e confira de novo."
          };
          // Não passaria = erro de dados (exit 2), como a conferência das outras
          // escritas: o dado sai no stdout e o código impede tratar como sucesso.
          return check.ok ? value : withExitCode(value, EXIT_CODES.USAGE);
        }

        const result = await kit.contracts.publishArtifact({
          ...owner,
          type: options.type,
          title: options.title,
          html,
          ...(options.accent ? { accent: options.accent } : {}),
          ...(options.density ? { density: options.density } : {}),
          ...(options.variant ? { variant: options.variant } : {}),
        });

        if (options.full) {
          return result;
        }
        // Saída ENXUTA (o back já devolve enxuto; passamos o essencial adiante).
        const r = (result.raw ?? {}) as Record<string, unknown>;
        return {
          artifactId: r.id_artifact,
          slug: r.slug,
          version: r.version,
          visibility: r.visibility,
          ...(owner.sessionId !== undefined
            ? // Artefato de CONVERSA: não há anexo de cartão; o chat mostra o artefato.
              { sessionId: owner.sessionId }
            : {
                cardId: owner.cardId,
                // Id do ANEXO cunhado: grave-o num campo de anexo (INPUT_ATTACH_FIELD)
                // via `card update-values` para o artefato aparecer NAQUELE campo.
                attachmentId: r.attachment_id
              }),
          ...(Array.isArray(r.warnings) && r.warnings.length > 0 ? { warnings: r.warnings } : {})
        };
      })
    );

  annotateCommand(command, {
    mutates: true,
    envelope:
      "cartão: { artifactId, slug, version, visibility, cardId, attachmentId, warnings? }; " +
      "conversa: { artifactId, slug, version, visibility, sessionId, warnings? }; com --full: { raw }; " +
      "com --dry-run: { dryRun, executed:false, ok, error?, warnings, normalizations, rawBytes, htmlBytes, cssBytes, maxCssBytes } (exit 2 quando não passaria)",
    fieldsLocation:
      ARTIFACT_HTML_RULES + " " +
      "Mudar SÓ o visual de um artefato publicado: `artifact get --id <id> --out <arquivo>`, edite, confira com --dry-run e publique com o MESMO --type no MESMO dono (nova versão), sem reler os dados. " +
      "Dono: --card-id (cartão) OU --session-id (conversa do agente, sem cartão); sem flag, usa RUNNER_CARD_ID e, sem cartão, RUNNER_CHAT_SESSION_ID (do ambiente do processo; o .env do diretório não define o dono). " +
      "Para pôr o artefato num CAMPO de anexo do card, grave o `attachmentId` no valor do campo (INPUT_ATTACH_FIELD) via `card update-values` (artefato de conversa não tem anexo).",
    example: 'artifact publish --card-id 1226170 --type mapa-cotacao --title "Mapa, Pedido 123" --file /tmp/mapa.html'
  });
}
