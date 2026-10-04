import { describe, expect, it } from "vitest";

import {
  continuationEchoFromApi,
  continuationNote,
  continuationStatus,
  continuationWindowLabel,
  NEXT_TASK_MAX_CHARS,
  NEXT_TASK_STORED_MAX_CHARS,
  nextTaskIssue,
  normalizeNextTask,
  storedNextTask
} from "../src/contracts/continuation.js";

// Rodada 8 (D5, 03/10): `--then` diz o que o agente faz depois da aprovação. O back
// guarda numa linha de até 1.000 caracteres e só quando o run é de conversa.

describe("tarefa seguinte (--then): normalização e situação", () => {
  it("uma linha, sem espaço sobrando; vazio ou ausente = null", () => {
    expect(normalizeNextTask("  listar os projetos\n\n com   saldo positivo  ")).toBe("listar os projetos com saldo positivo");
    expect(normalizeNextTask("   \n\t ")).toBeNull();
    expect(normalizeNextTask(undefined)).toBeNull();
    expect(normalizeNextTask(null)).toBeNull();
  });

  it("validação: ausente ok; informado vazio ou acima de 4.000 é problema", () => {
    expect(nextTaskIssue(undefined)).toBeNull();
    expect(nextTaskIssue("listar")).toBeNull();
    expect(nextTaskIssue("   ")).toContain("--then precisa da tarefa");
    expect(nextTaskIssue("x".repeat(NEXT_TASK_MAX_CHARS + 1))).toContain(`no máximo ${NEXT_TASK_MAX_CHARS}`);
    // Espaço que a normalização tira não conta para o teto.
    expect(nextTaskIssue(`${"a ".repeat(1999)}a${" ".repeat(500)}`)).toBeNull();
  });

  it("o que fica guardado: corte em 1.000 com reticências, igual ao back", () => {
    expect(storedNextTask("curto")).toBe("curto");
    const long = "y".repeat(1500);
    const stored = storedNextTask(long);
    expect(stored).toHaveLength(NEXT_TASK_STORED_MAX_CHARS);
    expect(stored.endsWith("…")).toBe(true);
    expect(storedNextTask("z".repeat(NEXT_TASK_STORED_MAX_CHARS))).toHaveLength(NEXT_TASK_STORED_MAX_CHARS);
  });

  const OK = { stored: true, hasGoal: true, thisConversation: true, windowMin: 120 };
  const NO_GOAL = { ...OK, hasGoal: false };
  const OTHER = { ...OK, thisConversation: false };

  it("eco do back: lê {stored, has_goal, this_conversation, window_min}; sem `stored` booleano = null", () => {
    expect(continuationEchoFromApi({ stored: true, has_goal: true, this_conversation: true, window_min: 120 })).toEqual(OK);
    expect(continuationEchoFromApi({ stored: false, has_goal: false, this_conversation: false, window_min: "x" })).toEqual({
      stored: false, hasGoal: false, thisConversation: false, windowMin: null
    });
    expect(continuationEchoFromApi(undefined)).toBeNull();
    expect(continuationEchoFromApi({ stored: "sim" })).toBeNull();
    expect(continuationEchoFromApi([true])).toBeNull();
    expect(continuationWindowLabel(120)).toBe("2 h");
    expect(continuationWindowLabel(90)).toBe("90 min");
    expect(continuationWindowLabel(null)).toBe("2 h");
  });

  it("situação: combinada só com o eco do back confirmando, em conversa e pedido novo (kit-2)", () => {
    expect(continuationStatus({ goal: null, deduped: false, inChat: true, echo: OK })).toBeNull();
    expect(continuationStatus({ goal: "x", deduped: false, inChat: true, echo: OK })).toBe("combinada");
    // Back sem a rodada 8 (zod descarta `then`) ou run sem conversa no back: sem promessa.
    expect(continuationStatus({ goal: "x", deduped: false, inChat: true })).toBe("não confirmada");
    expect(continuationStatus({ goal: "x", deduped: false, inChat: true, echo: null })).toBe("não confirmada");
    expect(continuationStatus({ goal: "x", deduped: false, inChat: true, echo: { ...OK, stored: false } })).toBe("não confirmada");
    expect(continuationStatus({ goal: "x", deduped: false, inChat: true, echo: OTHER })).toBe("não confirmada");
    expect(continuationStatus({ goal: "x", deduped: false, inChat: true, echo: NO_GOAL })).toBe("não confirmada");
    expect(continuationStatus({ goal: "x", deduped: true, inChat: true, echo: OK })).toBe("pedido anterior");
    expect(continuationStatus({ goal: "x", deduped: false, inChat: false, echo: OK })).toBe("sem conversa");
    expect(continuationStatus({ goal: "x", deduped: true, inChat: false })).toBe("sem conversa");
  });

  it("situação: dry-run nunca é combinada (kit-3)", () => {
    expect(continuationStatus({ goal: "x", deduped: false, inChat: true, echo: OK, dryRun: true })).toBe("ao enviar");
    expect(continuationStatus({ goal: null, deduped: false, inChat: true, dryRun: true, kind: "access" })).toBeNull();
    expect(continuationStatus({ goal: "x", deduped: false, inChat: false, dryRun: true })).toBe("sem conversa");
  });

  it("situação: acesso sem --then numa conversa confirmado pelo back também segue sozinho (kit-4); cabeça não", () => {
    expect(continuationStatus({ goal: null, deduped: false, inChat: true, echo: NO_GOAL, kind: "access" })).toBe("combinada");
    expect(continuationStatus({ goal: null, deduped: false, inChat: true, echo: null, kind: "access" })).toBeNull();
    expect(continuationStatus({ goal: null, deduped: false, inChat: true, echo: NO_GOAL, kind: "head" })).toBeNull();
    expect(continuationStatus({ goal: null, deduped: true, inChat: true, echo: NO_GOAL, kind: "access" })).toBeNull();
    const note = continuationNote("combinada", null, "access", { echo: NO_GOAL });
    expect(note).toContain("o Cange retoma esta conversa sozinho");
    expect(note).toContain("com o pedido original do usuário");
    expect(note).toContain("não peça ao usuário para avisar");
    expect(note).toContain("passe --then");
  });

  it("frase combinada traz as condições do D5: janela, sem mensagem nova, créditos e a oferta fora disso (kit-6)", () => {
    const combined = continuationNote("combinada", "listar os projetos", "access", { echo: OK });
    expect(combined).toContain(
      "Continuação combinada: se liberarem o acesso em até 2 h e o usuário não escrever nada antes, o Cange retoma esta conversa sozinho"
    );
    expect(combined).toContain("se houver créditos");
    expect(combined).toContain("Depois disso, o Cange só pergunta na conversa se deve seguir.");
    expect(combined).toContain('"listar os projetos"');
    expect(combined).toContain("você segue sozinho se liberarem o acesso em até 2 h");
    expect(combined).toContain("não peça ao usuário para avisar");
    expect(combined).not.toContain("assim que");
    expect(continuationNote("combinada", "x", "head", { echo: OK })).toContain("se aprovarem a mudança em até 2 h");
    // Janela configurada no back (AGENTS_CONTINUATION_MAX_AGE_MIN).
    expect(continuationNote("combinada", "x", "head", { echo: { ...OK, windowMin: 90 } })).toContain("em até 90 min");
  });

  it("frases sem promessa: ao enviar, não confirmada, pedido anterior (desta ou de outra conversa), sem conversa", () => {
    const dry = continuationNote("ao enviar", "x", "head");
    expect(dry).toContain("Se enviar com este --then");
    expect(dry).toContain("nada foi combinado");
    expect(dry).not.toContain("Enviado");
    const unconfirmed = continuationNote("não confirmada", "x", "access");
    expect(unconfirmed).toContain("não confirmou que guardou");
    expect(unconfirmed).toContain("Não prometa");
    const sameConv = continuationNote("pedido anterior", "x", "access", { echo: OK });
    expect(sameConv).toContain("nesta conversa");
    expect(sameConv).toContain("NÃO foi guardado");
    expect(sameConv).toContain("vale a tarefa combinada nele");
    // kit-7: pendente de outra conversa (ou eco ausente) nunca diz que vale o combinado.
    for (const echo of [OTHER, null, undefined]) {
      const text = continuationNote("pedido anterior", "x", "access", { echo });
      expect(text).toContain("talvez em outra conversa");
      expect(text).toContain("NÃO foi guardado");
      expect(text).toContain("Não prometa");
      expect(text).not.toContain("vale");
    }
    expect(continuationNote("sem conversa", "x", "head")).toContain("não é de uma conversa");
    expect(continuationNote(null, null, "access")).toBe("");
    for (const status of ["combinada", "não confirmada", "pedido anterior", "sem conversa", "ao enviar"] as const) {
      const text = continuationNote(status, "tarefa", "access", { echo: OK });
      expect(text.startsWith(" ")).toBe(true);
      expect(text).not.toContain("—");
      if (status !== "combinada") expect(text).not.toContain("Continuação combinada");
    }
  });
});
