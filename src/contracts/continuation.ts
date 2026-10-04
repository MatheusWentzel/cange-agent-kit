/**
 * Tarefa seguinte depois de uma aprovação (rodada 8, decisão D5 do Matheus, 03/10).
 *
 * `cange access request --then "<tarefa>"` e `cange agent head propose --then "<tarefa>"`
 * mandam `then` no corpo. O back guarda em `action_payload.continuation = {goal, session_id}`
 * só quando o run é de uma conversa de chat; quando alguém aprova, o Cange retoma a
 * conversa sozinho (uma vez, dentro da janela) com essa tarefa.
 *
 * Contrato do back: `then` (ou o sinônimo `next_task`) é string de até 4.000 caracteres,
 * normalizada para UMA linha de até 1.000. O kit normaliza do mesmo jeito para mostrar
 * na saída exatamente o que fica guardado.
 */

/** Teto do back para o campo cru (zod `max(4_000)`). */
export const NEXT_TASK_MAX_CHARS = 4000;
/** O back guarda numa linha de até 1.000 caracteres (CONTINUATION_GOAL_MAX_CHARS). */
export const NEXT_TASK_STORED_MAX_CHARS = 1000;

/** Uma linha, sem espaço sobrando. Vazio (ou ausente) = null. Puro. */
export function normalizeNextTask(raw: string | null | undefined): string | null {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  return text ? text : null;
}

/** Problema do `--then` informado (null = ok). Ausente é ok; informado vazio, não. Puro. */
export function nextTaskIssue(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const text = normalizeNextTask(raw);
  if (!text) {
    return "--then precisa da tarefa que você faz depois da aprovação (ex.: --then \"listar os projetos com saldo positivo\")";
  }
  if (text.length > NEXT_TASK_MAX_CHARS) {
    return `--then aceita no máximo ${NEXT_TASK_MAX_CHARS} caracteres: diga só o que falta fazer, numa frase`;
  }
  return null;
}

/** O que o back guarda: a mesma linha, cortada em 1.000 com reticências. Puro. */
export function storedNextTask(goal: string): string {
  return goal.length > NEXT_TASK_STORED_MAX_CHARS ? `${goal.slice(0, NEXT_TASK_STORED_MAX_CHARS - 1)}…` : goal;
}

/**
 * Eco do back na resposta do pedido (rodada 8, kit-2/kit-7): `continuation`
 * `{stored, has_goal, this_conversation, window_min}` no 201 e no 200 deduped.
 * O kit só promete seguir sozinho com esse eco; sem ele (back antigo), não promete.
 */
export interface ContinuationEcho {
  /** O pedido (o novo ou o pendente do dedupe) tem continuação guardada. */
  stored: boolean;
  /** Há tarefa seguinte guardada (--then). */
  hasGoal: boolean;
  /** A continuação guardada é desta conversa (a do run que chamou). */
  thisConversation: boolean;
  /** Janela do D5 entre o pedido e a aprovação, em minutos (null = não veio). */
  windowMin: number | null;
}

/** Lê o eco do back (tolerante). Sem `stored` booleano = null (back sem o eco). Puro. */
export function continuationEchoFromApi(raw: unknown): ContinuationEcho | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.stored !== "boolean") return null;
  const minutes = Number(r.window_min);
  return {
    stored: r.stored,
    hasGoal: r.has_goal === true,
    thisConversation: r.this_conversation === true,
    windowMin: Number.isFinite(minutes) && minutes > 0 ? minutes : null
  };
}

/** Janela padrão do back (AGENTS_CONTINUATION_MAX_AGE_MIN ausente). */
export const CONTINUATION_DEFAULT_WINDOW_MIN = 120;

/** "2 h", "90 min". Puro. */
export function continuationWindowLabel(minutes: number | null | undefined): string {
  const m = minutes && minutes > 0 ? minutes : CONTINUATION_DEFAULT_WINDOW_MIN;
  return m % 60 === 0 ? `${m / 60} h` : `${m} min`;
}

/**
 * Situação da continuação, do ponto de vista do kit:
 *  - `combinada`: pedido novo, numa conversa, e o back CONFIRMOU (eco) que guardou a
 *    continuação desta conversa. Com --then, a tarefa; no acesso sem --then, o pedido
 *    original do usuário. Segue sozinho só dentro das regras do D5 (janela, sem
 *    mensagem nova do usuário, créditos); fora delas, o Cange só oferece;
 *  - `não confirmada`: com --then numa conversa, mas o back não confirmou que guardou
 *    (back sem a rodada 8, ou run sem conversa no back): não prometer nada;
 *  - `pedido anterior`: o pedido já estava aberto (dedupe, talvez de outra conversa); o
 *    back NÃO troca a tarefa guardada nele, então o `--then` desta chamada não vale;
 *  - `sem conversa`: o run não é de chat (sem RUNNER_CHAT_SESSION_ID): o back não guarda
 *    nada e a aprovação não retoma nada;
 *  - `ao enviar`: dry-run; nada foi enviado nem combinado.
 */
export type ContinuationStatus = "combinada" | "não confirmada" | "pedido anterior" | "sem conversa" | "ao enviar";

export function continuationStatus(input: {
  goal: string | null;
  deduped: boolean;
  inChat: boolean;
  echo?: ContinuationEcho | null;
  dryRun?: boolean;
  kind?: "access" | "head";
}): ContinuationStatus | null {
  if (!input.inChat) return input.goal ? "sem conversa" : null;
  if (input.dryRun) return input.goal ? "ao enviar" : null;
  if (input.deduped) return input.goal ? "pedido anterior" : null;
  const confirmed = input.echo?.stored === true && input.echo.thisConversation === true;
  if (input.goal) return confirmed && input.echo!.hasGoal ? "combinada" : "não confirmada";
  // Sem --then: só o acesso guarda a conversa (o Cange retoma com o pedido original).
  return input.kind === "access" && confirmed ? "combinada" : null;
}

/**
 * Frase para o agente sobre a continuação (vai no `note`). Começa com espaço para
 * colar no fim da nota do comando; vazio quando não há o que dizer. Puro.
 */
export function continuationNote(
  status: ContinuationStatus | null,
  goal: string | null,
  kind: "access" | "head",
  options: { echo?: ContinuationEcho | null } = {}
): string {
  if (!status) return "";
  const decision = kind === "access" ? "liberarem o acesso" : "aprovarem a mudança";
  const window = continuationWindowLabel(options.echo?.windowMin);
  const rules = `se ${decision} em até ${window} e o usuário não escrever nada antes`;
  const after = "Depois disso, o Cange só pergunta na conversa se deve seguir.";
  if (status === "combinada") {
    if (!goal) {
      return (
        ` Continuação combinada: ${rules}, o Cange retoma esta conversa sozinho (uma vez, se houver créditos) ` +
        `com o pedido original do usuário. ${after} Na resposta, diga isso; não peça ao usuário para avisar. ` +
        "Da próxima vez, passe --then com a tarefa exata que você faz depois da liberação."
      );
    }
    return (
      ` Continuação combinada: ${rules}, o Cange retoma esta conversa sozinho (uma vez, se houver créditos) e faz: "${goal}". ` +
      `${after} Na resposta, diga que você segue sozinho se ${decision} em até ${window}; não peça ao usuário para avisar.`
    );
  }
  if (!goal) return "";
  if (status === "ao enviar") {
    return (
      ` Se enviar com este --then e ${decision} em até ${window}, sem mensagem nova do usuário, ` +
      `o Cange retoma esta conversa sozinho e faz: "${goal}". Por enquanto nada foi combinado.`
    );
  }
  if (status === "não confirmada") {
    return (
      " O Cange não confirmou que guardou o --then: esta conversa pode não seguir sozinha depois da aprovação. " +
      `Não prometa ao usuário que vai seguir sozinho; diga que, quando ${decision}, ele pode pedir de novo aqui.`
    );
  }
  if (status === "pedido anterior") {
    if (options.echo?.stored === true && options.echo.thisConversation === true) {
      return (
        " O pedido já estava aberto nesta conversa e o --then desta chamada NÃO foi guardado: " +
        (options.echo.hasGoal ? "vale a tarefa combinada nele. " : "nele não há tarefa seguinte combinada. ") +
        "Não prometa ao usuário que vai seguir com a tarefa nova sozinho."
      );
    }
    return (
      " O pedido já estava aberto, talvez em outra conversa, e o --then desta chamada NÃO foi guardado: " +
      "esta conversa pode não seguir sozinha depois da aprovação. Não prometa ao usuário que vai seguir sozinho."
    );
  }
  return (
    " Esta execução não é de uma conversa: o --then não fica guardado e a aprovação não retoma nada sozinha. " +
    "Não prometa ao usuário que vai seguir sozinho."
  );
}
