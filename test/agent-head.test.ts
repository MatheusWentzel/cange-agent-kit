import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentIdFromToken,
  composeModelFromArtifactCss,
  identityProposalNote,
  resolveSelfAgentId,
  sectionErrorHint
} from "../src/cli/commands/agent-head.js";
import { getCommandMeta } from "../src/cli/command-metadata.js";
import { EXIT_CODES } from "../src/cli/exit-codes.js";
import { createProgram } from "../src/cli/index.js";
import { normalizeHeadIndex, normalizeProposalResult } from "../src/contracts/agentHead.js";
import {
  isProhibitionSection,
  normalizeIdentityField,
  normalizeIdentityMode,
  normalizeIdentitySection
} from "../src/schemas/agentHead.js";

// Rodada 5 (01/10): auto-aperfeiçoamento. O agente lê a PRÓPRIA cabeça (índice e
// um modelo por vez) e PROPÕE mudanças (modelo, aprendizado, playbook). O dono do
// agente aprova no Cange; o kit só cria o pedido (POST /agent-head-proposal).

const envBackup = { ...process.env };

/** Token de run no formato do Cange: o `sub` é JSON com as claims (sem verificar assinatura). */
function runToken(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: JSON.stringify(claims), iat: 1 })}.assinatura`;
}

const TOKEN_164 = runToken({ id_user: 9969, company_id: 67, agent_id: 164, run_id: 180, token_type: "agent_run" });

const HEAD_WITH_INDEX = {
  agent: { id: 164, name: "Lia", memory_docs: JSON.stringify([{ id: "m1", name: "x", content: "SEGREDO DO MODELO" }]) },
  composed_markdown: "# Lia\n\nconteúdo grande da cabeça",
  head_index: {
    docs: [{ id: "d1", name: "aprendizados.md", kind: "doc", description: null, include_in_head: true, bytes: 120 }],
    models: [
      { id: "m1", name: "resumo-dos-projetos", kind: "modelo", description: "Resumo semanal", include_in_head: false, bytes: 4096 }
    ],
    playbooks: [{ step_ref: "automation", title: "Rotina", version: 2, bytes: 900 }],
    pending_proposals: [{ proposal_id: 31, kind: "modelo", summary: "Salvar o modelo", dt_created: "2026-10-01 09:00:00" }],
    self_improve_enabled: true,
    memory_docs_hash: "abc",
    read_model_command: "cange agent head doc --id <id> --out <arquivo>"
  }
};

const PROPOSAL_CREATED = {
  proposal_id: 42,
  approval_id: 42,
  status: "pending",
  deduped: false,
  kind: "modelo",
  summary: 'Salvar o modelo "resumo-dos-projetos" na própria cabeça',
  target: { doc_key: "memory:new", doc_id: null, name: "resumo-dos-projetos", exists: false },
  origin: "human_request",
  routed_to_user: { id_user: 76, name: "Matheus" },
  diff: { added: 12, removed: 0 },
  bytes: { before: 0, after: 900 },
  flags: [],
  content_sha: "f".repeat(64)
};

/** Rodada 7: resposta 201 do back para `kind: 'identidade'` (contrato do back). */
const IDENTITY_CREATED = {
  proposal_id: 77,
  approval_id: 77,
  status: "pending",
  deduped: false,
  kind: "identidade",
  summary: 'Acrescentar texto em "Escopo" na própria cabeça',
  target: { doc_key: "scope", doc_id: null, name: "Escopo", exists: true },
  origin: "human_request",
  routed_to_user: { id_user: 76, name: "Matheus" },
  diff: { added: 2, removed: 0 },
  bytes: { before: 300, after: 380 },
  flags: [],
  content_sha: "e".repeat(64),
  inline_allowed: true,
  requester_can_approve: true,
  identity: { field: "scope", field_label: "Escopo", mode: "append" }
};

describe("agente do token (sem --agent-id num run)", () => {
  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("lê o agent_id das claims do token de run (sub JSON)", () => {
    expect(agentIdFromToken(TOKEN_164)).toBe(164);
  });

  it("token que não é JWT ou sem a claim → undefined", () => {
    expect(agentIdFromToken("token")).toBeUndefined();
    expect(agentIdFromToken(runToken({ id_user: 1, company_id: 2 }))).toBeUndefined();
    expect(agentIdFromToken(undefined)).toBeUndefined();
  });

  it("precedência: --agent-id > RUNNER_AGENT_ID > token; nada disso é erro de uso", () => {
    delete process.env.RUNNER_AGENT_ID;
    expect(resolveSelfAgentId("7", TOKEN_164)).toBe(7);
    expect(resolveSelfAgentId(undefined, TOKEN_164)).toBe(164);
    process.env.RUNNER_AGENT_ID = "88";
    expect(resolveSelfAgentId(undefined, TOKEN_164)).toBe(88);
    delete process.env.RUNNER_AGENT_ID;
    expect(() => resolveSelfAgentId(undefined, "token")).toThrow(/--agent-id/);
    expect(() => resolveSelfAgentId("abc", TOKEN_164)).toThrow(/inteiro positivo/);
  });
});

describe("contratos da cabeça (normalização)", () => {
  it("índice do back vira camelCase, modelo nunca entra na cabeça", () => {
    const index = normalizeHeadIndex(HEAD_WITH_INDEX, 164);
    expect(index).toMatchObject({
      agentId: 164,
      agentName: "Lia",
      selfImproveEnabled: true,
      fromServerIndex: true,
      models: [{ id: "m1", name: "resumo-dos-projetos", kind: "modelo", includeInHead: false, bytes: 4096 }],
      docs: [{ id: "d1", name: "aprendizados.md", includeInHead: true }],
      playbooks: [{ stepRef: "automation", title: "Rotina", version: 2 }],
      pendingProposals: [{ proposalId: 31, kind: "modelo" }]
    });
  });

  it("back sem head_index: índice montado do memory_docs (kind/description) e sem playbooks", () => {
    const index = normalizeHeadIndex(
      {
        agent: {
          id: 164,
          name: "Lia",
          memory_docs: JSON.stringify([
            { id: "d1", name: "guia.md", content: "abc", include_in_head: true },
            { id: "m1", name: "modelo", content: "<style></style>", kind: "modelo", description: "quando usar", include_in_head: true }
          ])
        }
      },
      164
    );
    expect(index.fromServerIndex).toBe(false);
    expect(index.selfImproveEnabled).toBeNull();
    expect(index.playbooks).toBeNull();
    expect(index.models).toEqual([
      { id: "m1", name: "modelo", kind: "modelo", description: "quando usar", includeInHead: false, bytes: 15 }
    ]);
    expect(index.docs.map((d) => d.id)).toEqual(["d1"]);
    expect(index.references).toEqual([]);
  });

  it("rodada 6: docs de consulta (head_index.references, kind referencia) aparecem em references e nunca entram na cabeça", () => {
    const index = normalizeHeadIndex(
      {
        ...HEAD_WITH_INDEX,
        head_index: {
          ...HEAD_WITH_INDEX.head_index,
          references: [
            { id: "r1", name: "contrato.md", kind: "referencia", description: "Contrato do cliente", include_in_head: true, bytes: 40000 },
            { id: "r2", name: "manual.md", kind: "referencia", description: null, include_in_head: false, bytes: 52000 }
          ]
        }
      },
      164
    );
    expect(index.references).toEqual([
      { id: "r1", name: "contrato.md", kind: "referencia", description: "Contrato do cliente", includeInHead: false, bytes: 40000 },
      { id: "r2", name: "manual.md", kind: "referencia", description: null, includeInHead: false, bytes: 52000 }
    ]);
    expect(index.docs.map((d) => d.id)).toEqual(["d1"]);
    expect(index.models.map((d) => d.id)).toEqual(["m1"]);
  });

  it("rodada 6: back sem head_index separa referencia do memory_docs com includeInHead false", () => {
    const index = normalizeHeadIndex(
      {
        agent: {
          id: 164,
          memory_docs: JSON.stringify([
            { id: "d1", name: "guia.md", content: "abc", include_in_head: true },
            { id: "r1", name: "manual.md", content: "texto longo", kind: "referencia", include_in_head: true }
          ])
        }
      },
      164
    );
    expect(index.docs.map((d) => d.id)).toEqual(["d1"]);
    expect(index.references).toEqual([
      { id: "r1", name: "manual.md", kind: "referencia", description: null, includeInHead: false, bytes: 11 }
    ]);
  });

  it("resultado da proposta: ids, destino, aprovador e flags", () => {
    const result = normalizeProposalResult({ ...PROPOSAL_CREATED, flags: [{ code: "CLIENT_DATA_MONEY", message: "Tem valor" }] });
    expect(result).toMatchObject({
      proposalId: 42,
      approvalId: 42,
      status: "pending",
      deduped: false,
      target: { docKey: "memory:new", docId: null, name: "resumo-dos-projetos", exists: false },
      origin: "human_request",
      routedTo: { userId: 76, name: "Matheus" },
      diff: { added: 12, removed: 0 },
      flags: [{ code: "CLIENT_DATA_MONEY", message: "Tem valor" }]
    });
  });

  it("rodada 7: resultado da identidade traz campo e modo no nome do kit, inline e se quem pediu aprova", () => {
    const result = normalizeProposalResult({
      ...IDENTITY_CREATED,
      identity: { field: "policy_rules", field_label: "Regras de execução", mode: "replace" },
      inline_allowed: false,
      requester_can_approve: false
    });
    expect(result).toMatchObject({
      kind: "identidade",
      inlineAllowed: false,
      requesterCanApprove: false,
      identity: { field: "regras", fieldLabel: "Regras de execução", mode: "substituir" }
    });
    // Back sem `identity`: campo sai do target.doc_key, rótulo do kit.
    const { identity: _omit, inline_allowed: _i, requester_can_approve: _r, ...older } = IDENTITY_CREATED;
    expect(normalizeProposalResult(older)).toMatchObject({
      inlineAllowed: null,
      requesterCanApprove: null,
      identity: { field: "escopo", fieldLabel: "Escopo", mode: null }
    });
    // Proposta que não é identidade: sem identity.
    expect(normalizeProposalResult(PROPOSAL_CREATED).identity).toBeNull();
  });

  it("rodada 7: --field e --mode aceitam pt com e sem acento e o nome do back; o resto é undefined", () => {
    expect(normalizeIdentityField("missão")).toBe("missao");
    expect(normalizeIdentityField(" Escopo ")).toBe("escopo");
    expect(normalizeIdentityField("Políticas")).toBe("politicas");
    expect(normalizeIdentityField("regras")).toBe("regras");
    expect(normalizeIdentityField("policy_rules")).toBe("regras");
    expect(normalizeIdentityField("mission")).toBe("missao");
    expect(normalizeIdentityField("nome")).toBeUndefined();
    expect(normalizeIdentityMode("Acrescentar")).toBe("acrescentar");
    expect(normalizeIdentityMode("replace")).toBe("substituir");
    expect(normalizeIdentityMode("apagar")).toBeUndefined();
  });

  it("rodada 7: frase pronta diz onde aprovar (aqui na conversa × Aprovações do dono)", () => {
    const base = {
      proposalId: 77,
      deduped: false,
      routedTo: { name: "Matheus" },
      identity: { fieldLabel: "Escopo", mode: "acrescentar" }
    };
    const inline = identityProposalNote({ ...base, inlineAllowed: true, requesterCanApprove: true });
    expect(inline).toContain('mudar "Escopo"');
    expect(inline).toContain("quem pediu aprova aqui na conversa");
    expect(inline).toContain("PEDIU a aprovação");
    const owner = identityProposalNote({ ...base, inlineAllowed: true, requesterCanApprove: false });
    expect(owner).toContain("foi para as Aprovações de Matheus");
    expect(identityProposalNote({ ...base, deduped: true, inlineAllowed: null, requesterCanApprove: null })).toContain(
      "já aguardava aprovação"
    );
    // kit-1/kit-3: requester_can_approve ausente (null) não vira "foi para as Aprovações".
    const unknown = identityProposalNote({ ...base, deduped: true, inlineAllowed: true, requesterCanApprove: null });
    expect(unknown).toContain("já aguardava aprovação (#77; aguarda a aprovação de Matheus)");
    expect(unknown).not.toContain("Aprovações");
    expect(unknown).not.toContain("aprova aqui na conversa");
    // Dedupe com o booleano presente segue a regra de sempre.
    expect(identityProposalNote({ ...base, deduped: true, inlineAllowed: true, requesterCanApprove: true })).toContain(
      "quem pediu aprova aqui na conversa"
    );
    expect(identityProposalNote({ ...base, deduped: true, inlineAllowed: true, requesterCanApprove: false })).toContain(
      "foi para as Aprovações de Matheus"
    );
  });

  it("A1 (E2E r7): --section tira os # e espaços; seção de proibição pelo título", () => {
    expect(normalizeIdentitySection("## Você faz")).toBe("Você faz");
    expect(normalizeIdentitySection("  Você NÃO faz  ")).toBe("Você NÃO faz");
    expect(normalizeIdentitySection("### Regras ###")).toBe("Regras");
    expect(normalizeIdentitySection("  ")).toBe("");
    expect(normalizeIdentitySection(undefined)).toBeUndefined();
    expect(isProhibitionSection("Você NÃO faz")).toBe(true);
    expect(isProhibitionSection("Nunca")).toBe(true);
    expect(isProhibitionSection("Proibições")).toBe(true);
    expect(isProhibitionSection("Restrições")).toBe(true);
    // Review back-10 (rodada 7): títulos de proibição sem "não".
    for (const t of ["Fora do escopo", "Fora de escopo", "Fora do seu escopo", "Limites", "Ações vetadas"]) {
      expect(isProhibitionSection(t)).toBe(true);
    }
    expect(isProhibitionSection("Escopo")).toBe(false);
    expect(isProhibitionSection("Você faz")).toBe(false);
    expect(isProhibitionSection("Notas")).toBe(false);
    expect(isProhibitionSection(undefined)).toBe(false);
  });

  it("A1 (E2E r7): resultado da identidade traz a seção (null sem seção)", () => {
    const withSection = normalizeProposalResult({
      ...IDENTITY_CREATED,
      identity: { field: "scope", field_label: "Escopo", mode: "append", section: "Você faz" }
    });
    expect(withSection.identity).toEqual({ field: "escopo", fieldLabel: "Escopo", mode: "acrescentar", section: "Você faz" });
    expect(normalizeProposalResult(IDENTITY_CREATED).identity?.section).toBeNull();
  });

  it("A1 (E2E r7): dica das recusas de seção cita os títulos só quando a mensagem não citou e manda repetir com --section", () => {
    const titles = ["Você faz", "Você NÃO faz"];
    const required = sectionErrorHint("SECTION_REQUIRED", '"Escopo" é dividido em seções: "Você faz", "Você NÃO faz".', titles)!;
    expect(required).toContain('--section "<título>"');
    expect(required).toContain("seção de proibição");
    expect(required).not.toContain("Seções do texto atual");
    const ambiguous = sectionErrorHint("SECTION_AMBIGUOUS", "tem mais de uma seção", titles)!;
    expect(ambiguous).toContain('Seções do texto atual: "Você faz", "Você NÃO faz".');
    expect(ambiguous).toContain("Não insista");
    expect(sectionErrorHint("SECTION_NOT_FOUND", "não tem títulos", [])).toContain("SEM --section");
    expect(sectionErrorHint("SECTION_NOT_FOUND", "não tem a seção", null)).toContain("Repita com --section");
    expect(sectionErrorHint("SECTION_WITH_REPLACE", "x", null)).toContain("Tire o --section");
    expect(sectionErrorHint("NO_CHANGE", "x", titles)).toBeUndefined();
  });

  it("modelo do artefato: só o CSS vira o <style>, o esqueleto vem depois", () => {
    expect(composeModelFromArtifactCss("  .kpi { color: red; }\n", "\n<h1>{{titulo}}</h1>")).toBe(
      "<style data-artifact-css>\n.kpi { color: red; }\n</style>\n<h1>{{titulo}}</h1>"
    );
  });
});

describe("cange agent head / doc / propose (CLI)", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let dir: string;
  let skeletonPath: string;

  beforeEach(async () => {
    delete process.env.RUNNER_AGENT_ID;
    process.env.CANGE_ACCESS_TOKEN = TOKEN_164;
    stdout.length = 0;
    stderr.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    dir = await mkdtemp(join(tmpdir(), "cange-agent-head-"));
    skeletonPath = join(dir, "esqueleto.html");
    await writeFile(skeletonPath, "<h1>{{titulo}}</h1>\n<div class=\"kpi\">{{total}}</div><!-- /artifact -->", "utf8");
  });

  afterEach(async () => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function mockFetchSequence(responses: Array<{ body: unknown; status?: number }>) {
    let i = 0;
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const next = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" }
      });
    });
  }

  async function run(args: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  }

  function lastBody(fetchMock: { mock: { calls: unknown[][] } }, call = 0): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[call] ?? [];
    return JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
  }

  it("agent head: lê o índice do agente do TOKEN, sem despejar a cabeça nem conteúdo de modelo", async () => {
    const fetchMock = mockFetchSequence([{ body: HEAD_WITH_INDEX }]);

    await run(["agent", "head"]);

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/agent\/164\/head\?step_ref=automation&index=1$/);
    const printed = stdout.join("");
    expect(printed).not.toContain("SEGREDO DO MODELO");
    expect(printed).not.toContain("conteúdo grande da cabeça");
    const out = JSON.parse(printed);
    expect(out).toMatchObject({
      agentId: 164,
      selfImproveEnabled: true,
      models: [{ id: "m1", name: "resumo-dos-projetos", description: "Resumo semanal", bytes: 4096 }],
      readModel: "cange agent head doc --id <id> --out <arquivo>"
    });
    expect(out.note).toContain("cange agent head doc");
    expect(out.note).toContain("cange agent head propose");
    expect(out.note).not.toContain("—");
    expect(out.references).toEqual([]);
    expect(out.note).not.toContain("Docs de consulta");
  });

  it("agent head lista os docs de consulta em references[] (sem conteúdo) e avisa que não estão no prompt", async () => {
    mockFetchSequence([
      {
        body: {
          ...HEAD_WITH_INDEX,
          head_index: {
            ...HEAD_WITH_INDEX.head_index,
            references: [{ id: "r1", name: "contrato.md", kind: "referencia", description: "Contrato do cliente", include_in_head: false, bytes: 40000 }]
          }
        }
      }
    ]);
    await run(["agent", "head"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.references).toEqual([{ id: "r1", name: "contrato.md", description: "Contrato do cliente", bytes: 40000 }]);
    expect(out.docs.map((d: { id: string }) => d.id)).toEqual(["d1"]);
    expect(out.note).toContain("references[] NÃO estão no seu prompt");
    expect(out.note).not.toContain("—");
  });

  it("agent head com auto-aperfeiçoamento desligado avisa para não propor", async () => {
    mockFetchSequence([{ body: { ...HEAD_WITH_INDEX, head_index: { ...HEAD_WITH_INDEX.head_index, self_improve_enabled: false } } }]);
    await run(["agent", "head", "--agent-id", "164"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.selfImproveEnabled).toBe(false);
    expect(out.note).toContain("desligou o auto-aperfeiçoamento");
  });

  it("agent head sem agente (token sem a claim, sem flag) é erro de uso, sem chamar a API", async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(["agent", "head"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("agent head doc: grava o modelo no --out (absoluto) e não imprime o conteúdo", async () => {
    const fetchMock = mockFetchSequence([
      {
        body: {
          agent_id: 164,
          doc: {
            id: "m1",
            name: "resumo-dos-projetos",
            kind: "modelo",
            description: "Resumo semanal",
            include_in_head: false,
            content: "<style>.kpi{color:red}</style><h1>{{titulo}}</h1>",
            bytes: 48,
            sha256: "a".repeat(64)
          }
        }
      }
    ]);
    const out = join(dir, "sub", "modelo.html");

    await run(["agent", "head", "doc", "--id", "m1", "--out", out]);

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/agent\/164\/head\/doc\/m1$/);
    expect(await readFile(out, "utf8")).toBe("<style>.kpi{color:red}</style><h1>{{titulo}}</h1>");
    const printed = stdout.join("");
    expect(printed).not.toContain("{{titulo}}");
    const result = JSON.parse(printed);
    expect(result).toMatchObject({ agentId: 164, docId: "m1", kind: "modelo", out, bytes: 48 });
    expect(result.note).toContain("marcadores {{...}}");
  });

  it("agent head doc de consulta: kind referencia, fora da cabeça, nota de leitura sob demanda", async () => {
    mockFetchSequence([
      {
        body: {
          agent_id: 164,
          doc: { id: "r1", name: "contrato.md", kind: "referencia", include_in_head: true, content: "cláusula 1", bytes: 11 }
        }
      }
    ]);
    const out = join(dir, "contrato.md");
    await run(["agent", "head", "doc", "--id", "r1", "--out", out]);
    expect(await readFile(out, "utf8")).toBe("cláusula 1");
    const result = JSON.parse(stdout.join(""));
    expect(result).toMatchObject({ docId: "r1", kind: "referencia" });
    expect(result.note).toContain("Doc de consulta");
    expect(result.note).not.toContain("—");
  });

  it("agent head doc --agent-id (em qualquer posição) chega ao doc pelo comando pai", async () => {
    const fetchMock = mockFetchSequence([{ body: { agent_id: 7, doc: { id: "d1", name: "guia.md", kind: "doc", content: "oi" } } }]);
    await run(["agent", "head", "doc", "--id", "d1", "--agent-id", "7", "--out", join(dir, "guia.md")]);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/agent\/7\/head\/doc\/d1$/);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ agentId: 7, docId: "d1", kind: "doc" });
  });

  it("agent head doc com id inválido é erro de validação, sem chamar a API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(["agent", "head", "doc", "--id", "../x", "--out", join(dir, "x.html")]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("propose modelo --from-artifact: copia SÓ o CSS do /source e cria o pedido (agente do token, nunca do corpo)", async () => {
    const fetchMock = mockFetchSequence([
      {
        body: {
          id_artifact: 14,
          type: "status-report",
          title: "Resumo",
          session_id: 146,
          html: "<style data-artifact-css>.kpi{color:purple}</style><h1>Docile R$ 73.852</h1>",
          css: ".kpi{color:purple}",
          css_bytes: 18
        }
      },
      { body: PROPOSAL_CREATED, status: 201 }
    ]);

    await run([
      "agent", "head", "propose",
      "--kind", "modelo",
      "--name", "resumo-dos-projetos",
      "--description", "Resumo semanal dos projetos",
      "--file", skeletonPath,
      "--from-artifact", "14",
      "--reason", "Matheus pediu para salvar o estilo do resumo"
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/artifact\/14\/source$/);
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(String(url)).toMatch(/\/agent-head-proposal$/);
    expect((init as RequestInit).method).toBe("POST");
    const body = lastBody(fetchMock, 1);
    expect(body).toEqual({
      kind: "modelo",
      name: "resumo-dos-projetos",
      description: "Resumo semanal dos projetos",
      content:
        "<style data-artifact-css>\n.kpi{color:purple}\n</style>\n<h1>{{titulo}}</h1>\n<div class=\"kpi\">{{total}}</div><!-- /artifact -->",
      reason: "Matheus pediu para salvar o estilo do resumo",
      source_artifact_id: 14
    });
    expect(JSON.stringify(body)).not.toContain("Docile");
    expect(body).not.toHaveProperty("agent_id");

    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({
      proposalId: 42,
      approvalId: 42,
      status: "pending",
      deduped: false,
      origin: "human_request",
      routedTo: { userId: 76, name: "Matheus" },
      fromArtifact: { artifactId: 14, cssBytes: 18 }
    });
    expect(out.note).toContain("PEDIU a aprovação");
    expect(out.note).toContain("Matheus");
    expect(out.note).not.toContain("—");
    expect(process.exitCode).toBeUndefined();
  });

  it("propose --from-artifact com <style> no --file é erro de uso, sem chamar a API", async () => {
    await writeFile(skeletonPath, "<style>.x{}</style><h1>{{t}}</h1>", "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run([
      "agent", "head", "propose", "--kind", "modelo", "--name", "m", "--description", "d",
      "--file", skeletonPath, "--from-artifact", "14", "--reason", "pediram"
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.join("")).toContain("sem <style>");
  });

  it("propose --from-artifact fora do modelo é erro de uso", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(["agent", "head", "propose", "--kind", "aprendizado", "--file", skeletonPath, "--from-artifact", "14", "--reason", "x"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("propose modelo sem --description e playbook sem --step-ref: exit 2 com a regra da flag, sem chamar a API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(["agent", "head", "propose", "--kind", "modelo", "--name", "m", "--file", skeletonPath, "--reason", "x"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.join("")).toContain("--description é obrigatório no modelo");

    process.exitCode = undefined;
    stderr.length = 0;
    await run(["agent", "head", "propose", "--kind", "playbook", "--file", skeletonPath, "--reason", "x"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.join("")).toContain("--step-ref é obrigatório no playbook");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propose aprendizado acima de 4 KB e --kind fora da lista: exit 2, sem chamar a API", async () => {
    const big = join(dir, "grande.md");
    await writeFile(big, "x".repeat(4 * 1024 + 1), "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(["agent", "head", "propose", "--kind", "aprendizado", "--file", big, "--reason", "x"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.join("")).toContain("no máximo 4 KB");

    process.exitCode = undefined;
    stderr.length = 0;
    await run(["agent", "head", "propose", "--kind", "politica", "--file", big, "--reason", "x"]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.join("")).toContain("--kind precisa ser modelo, aprendizado, playbook");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propose aprendizado e playbook mandam só o que o tipo usa", async () => {
    const learning = join(dir, "aprendizado.md");
    await writeFile(learning, "Resumo semanal sai às segundas.", "utf8");
    const fetchMock = mockFetchSequence([
      { body: { ...PROPOSAL_CREATED, kind: "aprendizado" }, status: 201 },
      { body: { ...PROPOSAL_CREATED, kind: "playbook", proposal_id: 43, approval_id: 43 }, status: 201 }
    ]);

    await run(["agent", "head", "propose", "--kind", "aprendizado", "--file", learning, "--reason", "o usuário pediu para lembrar"]);
    expect(lastBody(fetchMock, 0)).toEqual({
      kind: "aprendizado",
      content: "Resumo semanal sai às segundas.",
      reason: "o usuário pediu para lembrar"
    });

    await run([
      "agent", "head", "propose", "--kind", "playbook", "--name", "Rotina", "--step-ref", "automation",
      "--file", learning, "--reason", "pediram um playbook"
    ]);
    expect(lastBody(fetchMock, 1)).toEqual({
      kind: "playbook",
      name: "Rotina",
      content: "Resumo semanal sai às segundas.",
      step_ref: "automation",
      reason: "pediram um playbook"
    });
  });

  it("propose --dry-run confere sem enviar", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run([
      "agent", "head", "propose", "--kind", "modelo", "--name", "m", "--description", "quando usar",
      "--file", skeletonPath, "--reason", "pediram", "--dry-run"
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ dryRun: true, executed: false, ok: true, kind: "modelo", name: "m" });
    expect(out.note).toContain("Nada foi enviado");
    expect(process.exitCode).toBeUndefined();
  });

  it("propose --dry-run que não passaria sai com exit 2 e o motivo no stdout", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(["agent", "head", "propose", "--kind", "modelo", "--name", "m", "--file", skeletonPath, "--reason", "x", "--dry-run"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ dryRun: true, ok: false });
    expect(out.error).toContain("--description é obrigatório no modelo");
  });

  it("proposta já pendente (200 deduped) diz para não repetir", async () => {
    mockFetchSequence([{ body: { ...PROPOSAL_CREATED, deduped: true }, status: 200 }]);
    await run(["agent", "head", "propose", "--kind", "modelo", "--name", "m", "--description", "d", "--file", skeletonPath, "--reason", "x"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.deduped).toBe(true);
    expect(out.note).toContain("já estava aguardando aprovação");
  });

  it("403 SELF_IMPROVE_DISABLED: exit 4 com o próximo passo (não propor de novo)", async () => {
    mockFetchSequence([
      {
        status: 403,
        body: {
          status: "error",
          message: "O auto-aperfeiçoamento está desligado para este agente.",
          complement: { code: "SELF_IMPROVE_DISABLED", action_kind: "cange:agent_head_propose" }
        }
      }
    ]);
    await run(["agent", "head", "propose", "--kind", "modelo", "--name", "m", "--description", "d", "--file", skeletonPath, "--reason", "x"]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
    const err = JSON.parse(stderr.join(""));
    expect(err.status).toBe(403);
    expect(err.code).toBe("SELF_IMPROVE_DISABLED");
    expect(err.message).toContain("Não proponha de novo");
  });

  // ---- rodada 7: proposta de identidade (missão, escopo, políticas, regras) ----

  it("propose identidade: traduz --field/--mode pt para o back (padrão acrescentar = append) e a saída traz a frase inline", async () => {
    const trecho = join(dir, "escopo.md");
    await writeFile(trecho, "- Criar cards no fluxo de vendas quando o usuário pedir.", "utf8");
    const fetchMock = mockFetchSequence([{ body: IDENTITY_CREATED, status: 201 }]);
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "escopo",
      "--file", trecho, "--reason", "Matheus pediu na conversa"
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/agent-head-proposal$/);
    expect((init as RequestInit).method).toBe("POST");
    expect(lastBody(fetchMock)).toEqual({
      kind: "identidade",
      field: "scope",
      mode: "append",
      content: "- Criar cards no fluxo de vendas quando o usuário pedir.",
      reason: "Matheus pediu na conversa"
    });
    expect(process.exitCode).toBeUndefined();
    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({
      proposalId: 77,
      approvalId: 77,
      status: "pending",
      kind: "identidade",
      field: "escopo",
      fieldLabel: "Escopo",
      mode: "acrescentar",
      inlineAllowed: true,
      requesterCanApprove: true,
      routedTo: { userId: 76, name: "Matheus" }
    });
    expect(out.note).toContain("quem pediu aprova aqui na conversa");
    expect(out.note).not.toContain("--name");
  });

  it("propose identidade substituir com campo acentuado: replace + policies; quem pediu não aprova = Aprovações do dono", async () => {
    const texto = join(dir, "politicas.md");
    await writeFile(texto, "Nunca mover para Ganho sem aprovação.\n", "utf8");
    const fetchMock = mockFetchSequence([
      {
        status: 201,
        body: {
          ...IDENTITY_CREATED,
          summary: 'Substituir "Políticas" na própria cabeça',
          target: { doc_key: "policies", doc_id: null, name: "Políticas", exists: true },
          flags: [{ code: "IDENTITY_REPLACE", message: "Substitui o texto inteiro" }],
          requester_can_approve: false,
          routed_to_user: { id_user: 12, name: "Ana" },
          identity: { field: "policies", field_label: "Políticas", mode: "replace" }
        }
      }
    ]);
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "Políticas", "--mode", "substituir",
      "--file", texto, "--reason", "Ana pediu"
    ]);
    expect(lastBody(fetchMock)).toMatchObject({ kind: "identidade", field: "policies", mode: "replace" });
    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ field: "politicas", fieldLabel: "Políticas", mode: "substituir", requesterCanApprove: false });
    expect(out.note).toContain("foi para as Aprovações de Ana");
    expect(out.note).toContain("IDENTITY_REPLACE");
  });

  it("propose identidade sem --field, com --field/--mode inválidos ou acima de 64 KB: exit 2, sem chamar a API", async () => {
    const texto = join(dir, "x.md");
    await writeFile(texto, "texto", "utf8");
    const big = join(dir, "grande.md");
    await writeFile(big, "x".repeat(65_536), "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cases: Array<[string[], string]> = [
      [["--file", texto], "--field é obrigatório na identidade"],
      [["--field", "nome", "--file", texto], "--field precisa ser missao, escopo, politicas ou regras"],
      [["--field", "escopo", "--mode", "apagar", "--file", texto], "--mode precisa ser acrescentar ou substituir"],
      [["--field", "missao", "--mode", "substituir", "--file", big], "64 KB"]
    ];
    for (const [extra, message] of cases) {
      process.exitCode = undefined;
      stderr.length = 0;
      await run(["agent", "head", "propose", "--kind", "identidade", ...extra, "--reason", "pediram"]);
      expect(process.exitCode, message).toBe(EXIT_CODES.USAGE);
      expect(stderr.join("")).toContain(message);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("kit-2: --name/--description/--step-ref na identidade é erro de uso (exit 2), inclusive no dry-run, sem chamar a API", async () => {
    const texto = join(dir, "missao2.md");
    await writeFile(texto, "Também ajudo com vendas.", "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cases: Array<[string[], string]> = [
      [["--name", "missao-nova"], "--name"],
      [["--description", "uma frase"], "--description"],
      [["--step-ref", "chat"], "--step-ref"],
      [["--name", "missao-nova", "--step-ref", "chat"], "--name, --step-ref"]
    ];
    for (const dryRun of [false, true]) {
      for (const [extra, received] of cases) {
        process.exitCode = undefined;
        stderr.length = 0;
        stdout.length = 0;
        await run([
          "agent", "head", "propose", "--kind", "identidade", "--field", "missao", ...extra,
          "--file", texto, "--reason", "pediram", ...(dryRun ? ["--dry-run"] : [])
        ]);
        expect(process.exitCode, `${extra.join(" ")} dry=${dryRun}`).toBe(EXIT_CODES.USAGE);
        const text = dryRun ? JSON.parse(stdout.join("")).error : stderr.join("");
        if (dryRun) expect(JSON.parse(stdout.join(""))).toMatchObject({ dryRun: true, ok: false });
        expect(text).toContain("--name, --description e --step-ref não valem para --kind identidade");
        expect(text).toContain(`recebido: ${received}`);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("kit-1/kit-3: 200 deduped da identidade sem requester_can_approve (gêmeo pendente) não manda para as Aprovações", async () => {
    const trecho = join(dir, "escopo-dedupe.md");
    await writeFile(trecho, "- Criar cards no fluxo de vendas quando o usuário pedir.", "utf8");
    // Corpo como o serializeCreated do back devolve no ramo pendingTwin: inline_allowed vem, requester_can_approve não.
    const { requester_can_approve: _omitido, ...dedupedBody } = IDENTITY_CREATED;
    mockFetchSequence([{ body: { ...dedupedBody, deduped: true }, status: 200 }]);
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "escopo",
      "--file", trecho, "--reason", "Matheus insistiu na conversa"
    ]);
    expect(process.exitCode).toBeUndefined();
    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ deduped: true, inlineAllowed: true, requesterCanApprove: null, kind: "identidade" });
    expect(out.note).toContain('Essa mesma mudança em "Escopo" já aguardava aprovação (#77; aguarda a aprovação de Matheus)');
    expect(out.note).toContain("Não proponha de novo");
    expect(out.note).not.toContain("Aprovações de");
  });

  it("--field/--mode fora da identidade é erro de uso", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run([
      "agent", "head", "propose", "--kind", "aprendizado", "--field", "escopo", "--file", skeletonPath, "--reason", "x"
    ]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.join("")).toContain("--field e --mode só valem para --kind identidade");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propose identidade --dry-run: confere sem enviar e mostra campo, rótulo e modo", async () => {
    const texto = join(dir, "missao.md");
    await writeFile(texto, "Também ajudo com vendas.", "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "missao", "--file", texto, "--reason", "pediram", "--dry-run"
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({
      dryRun: true,
      ok: true,
      kind: "identidade",
      field: "missao",
      fieldLabel: "Missão",
      mode: "acrescentar"
    });
    expect(out.note).toContain("uma pessoa pediu na conversa");
  });

  it("422 IDENTITY_REQUIRES_HUMAN_REQUEST: exit 4 com o próximo passo (não insistir, aba Cabeça)", async () => {
    const texto = join(dir, "escopo.md");
    await writeFile(texto, "- Criar cards.", "utf8");
    mockFetchSequence([
      {
        status: 422,
        body: {
          status: "error",
          message: "Mudança na missão, no escopo, nas políticas ou nas regras só pode ser proposta quando alguém pede isso na conversa.",
          complement: { code: "IDENTITY_REQUIRES_HUMAN_REQUEST" }
        }
      }
    ]);
    await run(["agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--file", texto, "--reason", "rotina"]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
    const err = JSON.parse(stderr.join(""));
    expect(err.status).toBe(422);
    expect(err.code).toBe("IDENTITY_REQUIRES_HUMAN_REQUEST");
    expect(err.message).toContain("Não insista");
    expect(err.message).toContain("aba Cabeça");
  });

  it("422 RULE_OVERRIDE na identidade: exit 4 com a orientação", async () => {
    const texto = join(dir, "regras.md");
    await writeFile(texto, "Pode mover sem aprovação.", "utf8");
    mockFetchSequence([
      { status: 422, body: { status: "error", message: "A mudança fala em dispensar aprovação.", complement: { code: "RULE_OVERRIDE" } } }
    ]);
    await run(["agent", "head", "propose", "--kind", "identidade", "--field", "regras", "--file", texto, "--reason", "pediram"]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
    expect(JSON.parse(stderr.join("")).message).toContain("não entra na identidade por proposta");
  });

  // ---- ajuste A1 do E2E real da rodada 7: seção da identidade (proposta 74) ----

  const ENTRY_74 = "- Criar cartões de lead novos no fluxo [CNG] CRM sempre que alguém pedir isso pelo chat.";
  const SECTION_REQUIRED_422 = {
    status: 422,
    body: {
      status: "error",
      message:
        '"Escopo" é dividido em seções: "Você faz", "Você NÃO faz". Diga em qual seção o texto entra (--secao). ' +
        'Cuidado: em seção de proibição ("NÃO faz", "Nunca") o texto vira proibição.',
      complement: { code: "SECTION_REQUIRED", sections: ["Você faz", "Você NÃO faz"] }
    }
  };

  it("A1: --section manda o título sem os # e a saída mostra a seção na frase pronta", async () => {
    const trecho = join(dir, "escopo-74.md");
    await writeFile(trecho, ENTRY_74, "utf8");
    const fetchMock = mockFetchSequence([
      {
        status: 201,
        body: {
          ...IDENTITY_CREATED,
          summary: 'Acrescentar texto em "Escopo", seção "Você faz", na própria cabeça',
          identity: { field: "scope", field_label: "Escopo", mode: "append", section: "Você faz" }
        }
      }
    ]);
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--section", "## Você faz",
      "--file", trecho, "--reason", "O Matheus pediu para eu poder criar cartões de lead pelo chat"
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(lastBody(fetchMock)).toEqual({
      kind: "identidade",
      field: "scope",
      mode: "append",
      content: ENTRY_74,
      reason: "O Matheus pediu para eu poder criar cartões de lead pelo chat",
      section: "Você faz"
    });
    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ kind: "identidade", field: "escopo", mode: "acrescentar", section: "Você faz" });
    expect(out.note).toContain('mudar "Escopo", seção "Você faz"');
    expect(out.note).not.toContain("NÃO faz");
  });

  it("A1: --secao (o nome que o back cita) é apelido de --section; dois títulos diferentes é erro de uso", async () => {
    const trecho = join(dir, "escopo-secao.md");
    await writeFile(trecho, ENTRY_74, "utf8");
    const fetchMock = mockFetchSequence([{ body: IDENTITY_CREATED, status: 201 }]);
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--secao", "Você faz",
      "--file", trecho, "--reason", "pediram"
    ]);
    expect(lastBody(fetchMock)).toMatchObject({ section: "Você faz" });
    fetchMock.mockClear();
    process.exitCode = undefined;
    stderr.length = 0;
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--section", "Você faz",
      "--secao", "Você NÃO faz", "--file", trecho, "--reason", "pediram"
    ]);
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(stderr.join("")).toContain("vieram dois títulos diferentes");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("A1: sem --section num campo com títulos, 422 SECTION_REQUIRED sai com a lista e o próximo passo (--section)", async () => {
    const trecho = join(dir, "escopo-sem-secao.md");
    await writeFile(trecho, ENTRY_74, "utf8");
    const fetchMock = mockFetchSequence([SECTION_REQUIRED_422]);
    await run(["agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--file", trecho, "--reason", "pediram"]);
    expect(lastBody(fetchMock)).not.toHaveProperty("section");
    expect(process.exitCode).toBe(EXIT_CODES.API);
    const err = JSON.parse(stderr.join(""));
    expect(err.status).toBe(422);
    expect(err.code).toBe("SECTION_REQUIRED");
    expect(err.message).toContain('"Você faz", "Você NÃO faz"');
    expect(err.message).toContain('Repita o mesmo comando com --section "<título>"');
    expect(err.message).toContain("só quando pediram para proibir");
    // A mensagem do back cita `--secao`; o kit troca pela flag documentada.
    expect(err.message).not.toContain("--secao");
    expect(err.details.complement.sections).toEqual(["Você faz", "Você NÃO faz"]);
  });

  it("A1: 422 SECTION_NOT_FOUND com a lista; sem títulos no texto manda repetir sem --section", async () => {
    const trecho = join(dir, "escopo-nf.md");
    await writeFile(trecho, ENTRY_74, "utf8");
    mockFetchSequence([
      {
        status: 422,
        body: {
          status: "error",
          message: '"Escopo" não tem a seção "Permissões". Seções que existem: "Você faz", "Você NÃO faz".',
          complement: { code: "SECTION_NOT_FOUND", sections: ["Você faz", "Você NÃO faz"] }
        }
      },
      {
        status: 422,
        body: {
          status: "error",
          message: '"Missão" não tem títulos de seção. Proponha o acréscimo sem seção (ele entra no fim do texto).',
          complement: { code: "SECTION_NOT_FOUND", sections: [] }
        }
      }
    ]);
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--section", "Permissões",
      "--file", trecho, "--reason", "pediram"
    ]);
    expect(process.exitCode).toBe(EXIT_CODES.API);
    const err = JSON.parse(stderr.join(""));
    expect(err.code).toBe("SECTION_NOT_FOUND");
    expect(err.message).toContain('"Você faz", "Você NÃO faz"');
    expect(err.message).toContain("Repita com --section usando um dos títulos que existem");

    stderr.length = 0;
    process.exitCode = undefined;
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "missao", "--section", "Você faz",
      "--file", trecho, "--reason", "pediram"
    ]);
    expect(JSON.parse(stderr.join("")).message).toContain("repita o mesmo comando SEM --section");
  });

  it("A1: --section vazio, longo demais, com substituir ou fora da identidade: exit 2, sem chamar a API", async () => {
    const texto = join(dir, "secao-invalida.md");
    await writeFile(texto, ENTRY_74, "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cases: Array<[string[], string]> = [
      [["--kind", "identidade", "--field", "escopo", "--section", " ## "], "--section precisa do título da seção"],
      [["--kind", "identidade", "--field", "escopo", "--section", "x".repeat(201)], "até 200 caracteres"],
      [
        ["--kind", "identidade", "--field", "escopo", "--mode", "substituir", "--section", "Você faz"],
        "--section só vale com --mode acrescentar"
      ],
      [["--kind", "aprendizado", "--section", "Você faz"], "--section só vale para --kind identidade"]
    ];
    for (const [extra, message] of cases) {
      process.exitCode = undefined;
      stderr.length = 0;
      await run(["agent", "head", "propose", ...extra, "--file", texto, "--reason", "pediram"]);
      expect(process.exitCode, message).toBe(EXIT_CODES.USAGE);
      expect(stderr.join("")).toContain(message);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("A1: --dry-run mostra a seção e avisa quando ela é de proibição", async () => {
    const texto = join(dir, "dry-74.md");
    await writeFile(texto, ENTRY_74, "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--section", "Você NÃO faz",
      "--file", texto, "--reason", "pediram", "--dry-run"
    ]);
    let out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ dryRun: true, ok: true, section: "Você NÃO faz" });
    expect(out.note).toContain('"Você NÃO faz" é uma seção de proibições');
    expect(out.note).toContain("vira algo que você NÃO faz");
    stdout.length = 0;
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--section", "Você faz",
      "--file", texto, "--reason", "pediram", "--dry-run"
    ]);
    out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ ok: true, section: "Você faz" });
    expect(out.note).not.toContain("seção de proibições");
    stdout.length = 0;
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "missao", "--file", texto, "--reason", "pediram", "--dry-run"
    ]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ ok: true, section: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("A1: proposta criada com SECTION_POLARITY_MISMATCH avisa o agente para dizer que a seção está errada", async () => {
    const trecho = join(dir, "escopo-mismatch.md");
    await writeFile(trecho, ENTRY_74, "utf8");
    mockFetchSequence([
      {
        status: 201,
        body: {
          ...IDENTITY_CREATED,
          identity: { field: "scope", field_label: "Escopo", mode: "append", section: "Você NÃO faz" },
          flags: [
            { code: "SECTION_PROHIBITION", message: "O texto entra em uma seção de proibições" },
            { code: "SECTION_POLARITY_MISMATCH", message: "O texto libera uma ação, mas entra numa seção que proíbe" }
          ]
        }
      }
    ]);
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--section", "Você NÃO faz",
      "--file", trecho, "--reason", "para eu poder criar cartões"
    ]);
    const out = JSON.parse(stdout.join(""));
    expect(out.section).toBe("Você NÃO faz");
    expect(out.note).toContain("SECTION_PROHIBITION, SECTION_POLARITY_MISMATCH");
    expect(out.note).toContain('o texto não combina com a seção "Você NÃO faz"');
    expect(out.note).toContain("quem aprova deve recusar esta proposta");
  });

  // Ajuste kit-1/kit-3: replay real da 74. O reason e o texto (SELECT no cange_local,
  // agent_approval 74) não casam com PERMISSIVE_CONTENT_RE do back, então sai SÓ
  // SECTION_PROHIBITION. Antes, a flag desligava o aviso do kit e a nota só mandava
  // dizer "pedi a aprovação".
  it("ajuste kit-3: só SECTION_PROHIBITION (replay da 74) ainda instrui o agente a dizer que a seção está errada", async () => {
    const trecho = join(dir, "escopo-74-replay.md");
    await writeFile(trecho, ENTRY_74, "utf8");
    mockFetchSequence([
      {
        status: 201,
        body: {
          ...IDENTITY_CREATED,
          identity: { field: "scope", field_label: "Escopo", mode: "append", section: "Você NÃO faz" },
          flags: [
            {
              code: "SECTION_PROHIBITION",
              message: 'O texto entra em "Você NÃO faz", uma seção de proibições: aprovado, vira algo que o agente NÃO faz.'
            }
          ]
        }
      }
    ]);
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--section", "Você NÃO faz",
      "--file", trecho,
      "--reason", "Usuário pediu no chat para acrescentar ao escopo a criação de cartões de lead novos no [CNG] CRM quando solicitado"
    ]);
    const out = JSON.parse(stdout.join(""));
    expect(out.section).toBe("Você NÃO faz");
    expect(out.flags.map((f: { code: string }) => f.code)).toEqual(["SECTION_PROHIBITION"]);
    expect(out.note).toContain('"Você NÃO faz" é uma seção de proibições');
    expect(out.note).toContain("vira algo que você NÃO faz");
    expect(out.note).toContain("diga ao usuário que a proposta ficou na seção errada e que quem aprova deve recusá-la");
    // A proposta já existe: a instrução não manda refazer com --section.
    expect(out.note).not.toContain("use --section");
    // O aviso vem antes da lista de códigos (o código cru sozinho não dizia nada).
    expect(out.note.indexOf("seção de proibições")).toBeLessThan(out.note.indexOf("Avisos que o dono vai ver: SECTION_PROHIBITION."));
    expect(out.note).not.toContain("—");
  });

  it("ajuste kit-3: proibição pelo título sem flag (back antigo) também avisa; seção \"Você faz\" não avisa", async () => {
    const trecho = join(dir, "escopo-sem-flag.md");
    await writeFile(trecho, ENTRY_74, "utf8");
    mockFetchSequence([
      { status: 201, body: { ...IDENTITY_CREATED, identity: { field: "scope", field_label: "Escopo", mode: "append", section: "Nunca" } } },
      { status: 201, body: { ...IDENTITY_CREATED, identity: { field: "scope", field_label: "Escopo", mode: "append", section: "Você faz" } } }
    ]);
    await run(["agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--section", "Nunca", "--file", trecho, "--reason", "pediram"]);
    expect(JSON.parse(stdout.join("")).note).toContain('"Nunca" é uma seção de proibições');
    stdout.length = 0;
    await run(["agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--section", "Você faz", "--file", trecho, "--reason", "pediram"]);
    expect(JSON.parse(stdout.join("")).note).not.toContain("seção de proibições");
  });

  it("ajuste kit-3: no --dry-run o aviso de proibição vem antes de \"Rode o mesmo comando sem --dry-run\"", async () => {
    const texto = join(dir, "dry-74-ordem.md");
    await writeFile(texto, ENTRY_74, "utf8");
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--section", "Você NÃO faz",
      "--file", texto, "--reason", "pediram", "--dry-run"
    ]);
    const note: string = JSON.parse(stdout.join("")).note;
    expect(note.indexOf("seção de proibições")).toBeGreaterThan(-1);
    expect(note.indexOf("seção de proibições")).toBeLessThan(note.indexOf("Rode o mesmo comando sem --dry-run."));
    expect(note.endsWith("Rode o mesmo comando sem --dry-run.")).toBe(true);
  });

  // Ajuste kit-2: back sem o A1 descarta `section` (zod strip) e acrescenta no FIM.
  it("ajuste kit-2: back não confirma a seção pedida: saída não afirma a seção e avisa que entra no fim", async () => {
    const trecho = join(dir, "escopo-sem-confirmar.md");
    await writeFile(trecho, ENTRY_74, "utf8");
    // Back pré-A1: identity sem section; e back mais antigo ainda, sem identity.
    const { identity: _omit, ...semIdentity } = IDENTITY_CREATED;
    mockFetchSequence([
      { status: 201, body: IDENTITY_CREATED },
      { status: 201, body: semIdentity }
    ]);
    for (let i = 0; i < 2; i++) {
      stdout.length = 0;
      await run([
        "agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--section", "Você faz",
        "--file", trecho, "--reason", "pediram"
      ]);
      const out = JSON.parse(stdout.join(""));
      expect(out.section).toBeNull();
      expect(out.requestedSection).toBe("Você faz");
      expect(out.note).not.toContain('seção "Você faz" (');
      expect(out.note).toContain('mudar "Escopo" (');
      expect(out.note).toContain('você pediu a seção "Você faz", mas o Cange não confirmou nenhuma seção');
      expect(out.note).toContain('o texto entra no FIM de "Escopo"');
      expect(out.note).toContain("quem aprova precisa conferir onde o texto entra");
    }
  });

  it("ajuste kit-2: sem --section não há aviso de seção não confirmada", async () => {
    const trecho = join(dir, "missao-sem-secao.md");
    await writeFile(trecho, ENTRY_74, "utf8");
    mockFetchSequence([{ status: 201, body: { ...IDENTITY_CREATED, identity: { field: "mission", field_label: "Missão", mode: "append" } } }]);
    await run(["agent", "head", "propose", "--kind", "identidade", "--field", "missao", "--file", trecho, "--reason", "pediram"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.section).toBeNull();
    expect(out).not.toHaveProperty("requestedSection");
    expect(out.note).not.toContain("não confirmou");
  });

  // ---- rodada 8 (D5): --then (tarefa seguinte depois da aprovação) ----

  const ECHO_OK = { stored: true, has_goal: true, this_conversation: true, window_min: 120 };

  it("propose modelo --then numa conversa: manda `then` e a saída mostra a continuação combinada", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    const fetchMock = mockFetchSequence([{ body: { ...PROPOSAL_CREATED, continuation: ECHO_OK }, status: 201 }]);
    await run([
      "agent", "head", "propose", "--kind", "modelo", "--name", "m", "--description", "d",
      "--file", skeletonPath, "--reason", "pediram", "--then", " gerar o relatório\n  com o modelo novo "
    ]);
    expect(lastBody(fetchMock)).toEqual({
      kind: "modelo",
      name: "m",
      description: "d",
      content: "<h1>{{titulo}}</h1>\n<div class=\"kpi\">{{total}}</div><!-- /artifact -->",
      reason: "pediram",
      then: "gerar o relatório com o modelo novo"
    });
    const out = JSON.parse(stdout.join(""));
    expect(out.continuation).toBe("combinada");
    expect(out.then).toBe("gerar o relatório com o modelo novo");
    expect(out.note).toContain("Pedido de aprovação #42");
    expect(out.note).toContain(
      "Continuação combinada: se aprovarem a mudança em até 2 h e o usuário não escrever nada antes, o Cange retoma esta conversa sozinho"
    );
    expect(out.note).toContain("não peça ao usuário para avisar");
    expect(out.note).not.toContain("—");
  });

  it("propose identidade --then: `then` vai no corpo da identidade e a saída combina a continuação", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    const trecho = join(dir, "escopo-then.md");
    await writeFile(trecho, "- Publicar artefato com a lista pedida.", "utf8");
    const fetchMock = mockFetchSequence([{ body: { ...IDENTITY_CREATED, continuation: ECHO_OK }, status: 201 }]);
    await run([
      "agent", "head", "propose", "--kind", "identidade", "--field", "escopo",
      "--file", trecho, "--reason", "Matheus pediu", "--then", "publicar o PDF com a lista"
    ]);
    expect(lastBody(fetchMock)).toEqual({
      kind: "identidade",
      field: "scope",
      mode: "append",
      content: "- Publicar artefato com a lista pedida.",
      reason: "Matheus pediu",
      then: "publicar o PDF com a lista"
    });
    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ kind: "identidade", continuation: "combinada", then: "publicar o PDF com a lista" });
    expect(out.note).toContain("quem pediu aprova aqui na conversa");
    expect(out.note).toContain("Continuação combinada");
    // kit-1/kit-5: a nota da identidade não pode adiar para a "próxima conversa" (C8: aprovada, já vale agora).
    expect(out.note).not.toContain("próxima conversa");
    expect(out.note).toContain("aprovada, já vale a partir de agora, nesta conversa também");
  });

  it("kit-1: nota da identidade sem --then também não adia para a próxima conversa", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    const trecho = join(dir, "escopo-sem-then.md");
    await writeFile(trecho, "- Publicar artefato com a lista pedida.", "utf8");
    mockFetchSequence([{ body: IDENTITY_CREATED, status: 201 }]);
    await run(["agent", "head", "propose", "--kind", "identidade", "--field", "escopo", "--file", trecho, "--reason", "Matheus pediu"]);
    const out = JSON.parse(stdout.join(""));
    expect(out.note).not.toContain("próxima conversa");
    expect(out.note).toContain("só vale depois de aprovada");
  });

  it("kit-2: 201 sem o eco do back, com --then e conversa: NÃO diz combinada (modelo e identidade)", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    const trecho = join(dir, "escopo-sem-eco.md");
    await writeFile(trecho, "- Publicar artefato com a lista pedida.", "utf8");
    for (const [body, args] of [
      [PROPOSAL_CREATED, ["--kind", "modelo", "--name", "m", "--description", "d", "--file", skeletonPath]],
      [{ ...IDENTITY_CREATED, continuation: { ...ECHO_OK, stored: false, has_goal: false, this_conversation: false } }, ["--kind", "identidade", "--field", "escopo", "--file", trecho]]
    ] as const) {
      stdout.length = 0;
      mockFetchSequence([{ body, status: 201 }]);
      await run(["agent", "head", "propose", ...args, "--reason", "x", "--then", "gerar o relatório"]);
      const out = JSON.parse(stdout.join(""));
      expect(out.continuation).toBe("não confirmada");
      expect(out).not.toHaveProperty("then");
      expect(out.note).not.toContain("Continuação combinada");
      expect(out.note).toContain("Não prometa ao usuário que vai seguir sozinho");
    }
  });

  it("kit-7: proposta gêmea pendente de OUTRA conversa: não diz que vale o combinado", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "230";
    mockFetchSequence([{ body: { ...PROPOSAL_CREATED, deduped: true, continuation: { ...ECHO_OK, this_conversation: false } }, status: 200 }]);
    await run([
      "agent", "head", "propose", "--kind", "modelo", "--name", "m", "--description", "d",
      "--file", skeletonPath, "--reason", "x", "--then", "gerar o relatório"
    ]);
    const out = JSON.parse(stdout.join(""));
    expect(out.continuation).toBe("pedido anterior");
    expect(out.note).toContain("talvez em outra conversa");
    expect(out.note).not.toContain("vale o que ficou combinado");
  });

  it("propose sem --then: corpo e saída como antes (sem then nem continuation)", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    const fetchMock = mockFetchSequence([{ body: PROPOSAL_CREATED, status: 201 }]);
    await run(["agent", "head", "propose", "--kind", "modelo", "--name", "m", "--description", "d", "--file", skeletonPath, "--reason", "x"]);
    expect(lastBody(fetchMock)).not.toHaveProperty("then");
    const out = JSON.parse(stdout.join(""));
    expect(out).not.toHaveProperty("continuation");
    expect(out).not.toHaveProperty("then");
    expect(out.note).not.toContain("Continuação");
  });

  it("propose --then que cai no dedupe: avisa que o --then novo não foi guardado", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    mockFetchSequence([{ body: { ...PROPOSAL_CREATED, deduped: true }, status: 200 }]);
    await run([
      "agent", "head", "propose", "--kind", "modelo", "--name", "m", "--description", "d",
      "--file", skeletonPath, "--reason", "x", "--then", "gerar o relatório"
    ]);
    const out = JSON.parse(stdout.join(""));
    expect(out.continuation).toBe("pedido anterior");
    expect(out).not.toHaveProperty("then");
    expect(out.note).toContain("já estava aguardando aprovação");
    expect(out.note).toContain("NÃO foi guardado");
  });

  it("propose --then fora de conversa: não promete seguir sozinho", async () => {
    delete process.env.RUNNER_CHAT_SESSION_ID;
    mockFetchSequence([{ body: PROPOSAL_CREATED, status: 201 }]);
    await run([
      "agent", "head", "propose", "--kind", "modelo", "--name", "m", "--description", "d",
      "--file", skeletonPath, "--reason", "x", "--then", "gerar o relatório"
    ]);
    const out = JSON.parse(stdout.join(""));
    expect(out.continuation).toBe("sem conversa");
    expect(out.note).toContain("não é de uma conversa");
    expect(out.note).not.toContain("Continuação combinada");
  });

  it("propose --dry-run com --then mostra a tarefa sem enviar; numa conversa sem --then, sugere o --then", async () => {
    process.env.RUNNER_CHAT_SESSION_ID = "221";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run([
      "agent", "head", "propose", "--kind", "modelo", "--name", "m", "--description", "d",
      "--file", skeletonPath, "--reason", "x", "--then", "gerar o relatório", "--dry-run"
    ]);
    let out = JSON.parse(stdout.join(""));
    // kit-3: o dry-run nunca devolve "combinada" (nada foi enviado nem combinado).
    expect(out).toMatchObject({ dryRun: true, executed: false, ok: true, continuation: "ao enviar", then: "gerar o relatório" });
    expect(out.continuation).not.toBe("combinada");
    expect(out.note).toContain("Nada foi enviado");
    expect(out.note).toContain("Se enviar com este --then");
    expect(out.note).toContain("nada foi combinado");
    expect(out.note).not.toContain("Enviado com este --then");
    expect(out.note).not.toContain("Continuação combinada");

    stdout.length = 0;
    await run(["agent", "head", "propose", "--kind", "aprendizado", "--file", skeletonPath, "--reason", "x", "--dry-run"]);
    out = JSON.parse(stdout.join(""));
    expect(out).not.toHaveProperty("continuation");
    expect(out.note).toContain("acrescente --then");

    stdout.length = 0;
    delete process.env.RUNNER_CHAT_SESSION_ID;
    await run(["agent", "head", "propose", "--kind", "aprendizado", "--file", skeletonPath, "--reason", "x", "--dry-run"]);
    expect(JSON.parse(stdout.join("")).note).not.toContain("--then");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propose --then vazio ou acima de 4.000: exit 2 (inclusive no dry-run), sem chamar a API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const extra of [[], ["--dry-run"]]) {
      for (const value of ["  ", "x".repeat(4001)]) {
        process.exitCode = undefined;
        stdout.length = 0;
        stderr.length = 0;
        await run([
          "agent", "head", "propose", "--kind", "modelo", "--name", "m", "--description", "d",
          "--file", skeletonPath, "--reason", "x", "--then", value, ...extra
        ]);
        expect(process.exitCode).toBe(EXIT_CODES.USAGE);
        expect(`${stdout.join("")}${stderr.join("")}`).toContain("--then");
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("árvore do CLI: agent head (leitura) com doc e propose; propose marcado como escrita", () => {
    type Cmd = { name(): string; commands: readonly Cmd[] };
    const program = createProgram() as unknown as Cmd;
    const agent = program.commands.find((c) => c.name() === "agent");
    const head = agent?.commands.find((c) => c.name() === "head");
    expect(head?.commands.map((c) => c.name()).sort()).toEqual(["doc", "propose"]);
    const propose = head!.commands.find((c) => c.name() === "propose")!;
    expect(getCommandMeta(propose as never)?.mutates).toBe(true);
    expect(getCommandMeta(head as never)?.mutates).toBeUndefined();
    // Rodada 7: o runner liga a receita de identidade quando o propose tem --field e --mode.
    const longs = (propose as unknown as { options: Array<{ long?: string }> }).options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(["--field", "--mode", "--section", "--secao", "--then"]));
  });
});
