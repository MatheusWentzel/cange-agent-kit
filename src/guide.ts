/**
 * Guia de trabalho do agente com o Cange VIA ESTE KIT (CLI `cange`).
 *
 * Fonte ÚNICA das jornadas/regras/armadilhas — renderizada em três lugares sem
 * divergir: (1) embutida no `cange manifest` (o agente já trata o manifest como
 * verdade); (2) o comando `cange guide` (bússola quando se perde); (3) o notice
 * que o runner injeta no system prompt do agente.
 *
 * POR QUE existe: um agente headless não tem UI que o guie. Sem isto ele ADIVINHA
 * o caminho e queima turno/custo — caso real: o agente Comprador não sabia baixar
 * um anexo, tentou curl no blob cru (404/403), gastou US$2,42 e não processou nada.
 * O guia ensina o CAMINHO CERTO de cada tarefa comum, com o comando exato.
 */

export interface Journey {
  id: string;
  /** Título curto da jornada. */
  title: string;
  /** Quando seguir esta jornada. */
  when: string;
  /** Passos na ordem — cada um com o comando `cange` exato. */
  steps: string[];
  /** Armadilha específica desta jornada (o erro comum que ela evita). */
  pitfall?: string;
}

/**
 * Jornadas canônicas. O MAPA vem primeiro (é o passo 0 de qualquer tarefa);
 * ANEXO em seguida por ser a jornada mais errada por agentes (e a que o MCP
 * nem cobre).
 */
export const JOURNEYS: Journey[] = [
  {
    id: "mapear_ambiente",
    title: "Entender o ambiente (mapa de flows, etapas, campos e vínculos)",
    when: "início de QUALQUER tarefa em que você ainda não conhece a estrutura (qual flow, quais etapas, onde cada campo vive, como os flows se relacionam)",
    steps: [
      "cange map — devolve em UMA chamada: flows acessíveis, etapas (id/nome/form), campos (id/hash/título/tipo/obrigatório/form) e os RELACIONAMENTOS entre flows (COMBO_BOX_FLOW_FIELD) + cadastros usados.",
      "cange map --flow-id <f> — versão enxuta de um flow só.",
      "Com o mapa em mãos: campo com formId == formInitId é do form de CRIAÇÃO; campo com formId de uma etapa (steps[].formId) é campo de ETAPA."
    ],
    pitfall:
      "NÃO reconstrua o ambiente na unha (my-flows + flow get + fields by-flow flow a flow + tentativa-e-erro): isso queima dezenas de turnos. `cange map` substitui essa exploração inteira."
  },
  {
    id: "ler_anexo",
    title: "Ler um anexo/arquivo de um card (PDF, imagem, etc.)",
    when: "a tarefa depende de um arquivo anexado no card (proposta, documento, comprovante…)",
    steps: [
      "cange card get --flow-id <f> --card-id <c> — o anexo vive num CAMPO do card (tipo INPUT_ATTACH_FIELD), NÃO na colaboração/relacionamento do card.",
      "cange attachment download --flow-id <f> --card-id <c> --out <dir> — baixa TODOS os anexos do card para <dir> e devolve os CAMINHOS (nunca o base64). Sem --out, só lista.",
      "Read <dir>/<arquivo> — leia o arquivo baixado (o Read renderiza PDF/imagem)."
    ],
    pitfall:
      "NUNCA baixe o anexo com curl na URL do blob (Azure): ela é privada/expira e dá 404/403. " +
      "SEMPRE use `cange attachment download` — ele passa pela rota autenticada do Cange, que lê o arquivo no servidor."
  },
  {
    id: "ler_card",
    title: "Ler um card e seus campos",
    when: "precisa dos valores atuais de um card",
    steps: [
      "cange card read --flow-id <f> --card-id <c> — leitura ENXUTA: etapa atual + fieldValues legíveis (chave = field id, valor textual). Use este por PADRÃO.",
      "cange card get --flow-id <f> --card-id <c> — só quando precisar do `raw` completo (pesado: pode passar de 700 KB)."
    ],
    pitfall:
      "NÃO parseie o `raw` do card get para achar valores — os valores legíveis já vêm prontos no `card read` (fieldValues). " +
      "Registro ATIVO vs deletado: a verdade é o campo `deleted` (\"N\"=ativo, \"S\"=deletado); NÃO use `dt_deleted` (vem preenchido em ativos)."
  },
  {
    id: "escrever_campos",
    title: "Escrever/atualizar valores de um card",
    when: "precisa gravar um resultado, parecer ou dado num campo do card",
    steps: [
      "Descubra os campos: `cange fields by-flow --flow-id <f>` (form de criação) ou `cange step-form --flow-id <f> --step-id <s>` (campos da ETAPA).",
      "Monte um arquivo .json com `values` (chave = `id` do field; valor de opção = CÓDIGO).",
      "Campo do FORM DE CRIAÇÃO → `cange card update-values --payload <arquivo.json>`. Campo de ETAPA → `cange card move-step-with-values --payload <arquivo.json>`.",
      "Rode antes com `--dry-run` e/ou `--validate-fields` para pegar UNKNOWN_FIELD/shape errado sem mutar."
    ],
    pitfall:
      "UNKNOWN_FIELD = o field não pertence à estrutura consultada. Campo de ETAPA não grava por `update-values` (valida contra o form de criação) — use `move-step-with-values`. " +
      "Confirme o id/tipo do field com `fields by-flow`/`step-form` ANTES de gravar."
  },
  {
    id: "comentar",
    title: "Entregar um resultado/comentário no card",
    when: "concluiu a análise e precisa registrar o resultado no card",
    steps: [
      "Escreva o texto (markdown) num arquivo .json: `{ \"cardId\": <c>, \"flowId\": <f>, \"description\": \"<texto>\", \"mentions\": [] }`.",
      "cange comment create --payload <arquivo.json> — o grupo é `comment`, o subcomando é `create`. Não existe `cange comment` sozinho nem `cange card comment`."
    ],
    pitfall: "`--payload` é SEMPRE um CAMINHO DE ARQUIVO .json — NUNCA JSON inline. É isso que faz body grande funcionar."
  },
  {
    id: "mover_card",
    title: "Mover um card de etapa",
    when: "avançar o card para outra etapa do fluxo",
    steps: [
      "cange map --flow-id <f> (ou cange flow get --flow-id <f>) — descubra os ids das etapas de ORIGEM e DESTINO.",
      "cange template step-move --flow-id <f> --from-step-id <origem> --to-step-id <destino> --card-id <c> — gera o payloadSkeleton PRONTO (com os campos obrigatórios do move e o cardId preenchido). Grave-o num arquivo .json e preencha os values.",
      "cange card move-step-with-values --payload <arquivo.json> --dry-run — valide; depois rode sem --dry-run."
    ],
    pitfall:
      "O template exige --from-step-id E --to-step-id (não existe --step-id). O skeleton já sai com ids numéricos — use-o como base em vez de montar o payload do zero."
  },
  {
    id: "achar_estrutura",
    title: "Descobrir fluxo, etapas e campos",
    when: "não sabe os ids de flow/etapa/campo",
    steps: [
      "cange map — o mapa completo em 1 chamada (flows + etapas + campos + vínculos). Comece por ele.",
      "cange step-form --flow-id <f> --step-id <s> — detalhe dos campos de UMA etapa (obrigatórios do move).",
      "cange fields by-flow --flow-id <f> — todos os campos do flow (com o form de cada um)."
    ]
  },
  {
    id: "ler_cadastro",
    title: "Ler as entradas de um cadastro (register)",
    when: "listar registros (clientes, produtos, fornecedores…)",
    steps: [
      "cange my-registers — ache o cadastro e seu id.",
      "cange register entries --register-id <r> — lê as entradas (roteia engine v1/v2 sozinho; use `--search` para filtrar)."
    ]
  }
];

/** Regras de ouro — valem em quase toda interação de escrita/leitura. */
export const GOLDEN_RULES: string[] = [
  "Comece pelo MAPA: `cange map` dá flows + etapas + campos + vínculos em 1 chamada — não reconstrua o ambiente na unha.",
  "Ler card: `cange card read` (enxuto) por padrão; `card get` (com raw pesado) só quando precisar da estrutura crua.",
  "Toda MUTAÇÃO (comment/update/move/add-child) usa `--payload <arquivo.json>` — caminho de ARQUIVO, NUNCA JSON inline. Leitura usa flags diretas.",
  "Em `values`, a chave é o `id`/`name` do field (de `fields by-flow`/`step-form`), e o valor de um campo de opção é o CÓDIGO (`value`), não o texto.",
  "Ler texto de campo: use `valueString`; `value` costuma ser só o código da opção.",
  "Registro ativo vs deletado: olhe o campo `deleted` (\"N\"/\"S\"), não `dt_deleted`.",
  "Anexo: SEMPRE `cange attachment download`, NUNCA curl no blob cru.",
  "Campo do form de criação → `card update-values`; campo de ETAPA → `card move-step-with-values`.",
  "Ids em flags e payloads: use o padrão `--flow-id`/`--card-id`/`--register-id`; nos payloads, ids numéricos (string numérica também é aceita)."
];

/** Armadilhas do ambiente headless do runner (queimam turno se ignoradas). */
export const GOTCHAS: string[] = [
  "Ambiente headless: NÃO existem `python3`, `jq`, `file`, `timeout`. Use Node (`node -e`), as ferramentas Read/Grep e o CLI `cange` — não dependa daqueles binários.",
  "Kit SEMPRE, MCP NUNCA: use o CLI `cange` (autentica como você). Nunca use um conector MCP do Cange — ele autentica como outro usuário e quebra fila/auditoria.",
  "Se um comando falhar com `unknown command`/`required option`, PARE e consulte `cange manifest --output json` ou `cange guide` — não tente às cegas.",
  "Antes de encerrar, ENTREGUE o resultado no card (`cange comment create` e/ou escrita de campos). Enquanto não entregar, a tarefa NÃO está concluída."
];

/** Nome do comando no início de um passo (antes do " — " ou " ("). */
function commandOf(step: string): string {
  const head = step.split("—")[0] ?? step;
  return head.replace(/\s*\(.*/, "").trim();
}

/** Payload estruturado do guia (usado pelo `cange guide --output json` e pelo manifest). */
export function guidePayload(): {
  regrasDeOuro: string[];
  jornadas: Array<{ id: string; quando: string; passos: string[]; armadilha?: string }>;
  armadilhas: string[];
  dica: string;
} {
  return {
    regrasDeOuro: GOLDEN_RULES,
    jornadas: JOURNEYS.map((j) => ({
      id: j.id,
      quando: j.when,
      passos: j.steps,
      ...(j.pitfall ? { armadilha: j.pitfall } : {})
    })),
    armadilhas: GOTCHAS,
    dica: "Comece por `cange my-flows` (todo flowId sai daí) e `cange fields by-flow`/`step-form` (todo id/tipo de campo sai daí). Detalhe de um comando: `cange <path> --help`."
  };
}

/** Render compacto (para as instructions/notice do runner — poucas linhas). */
export function guideAsText(): string {
  const jornadas = JOURNEYS.map((j) => `• ${j.title} (${j.when}): ${j.steps.map(commandOf).join(" → ")}`).join("\n");
  return [
    "REGRAS DE OURO:",
    ...GOLDEN_RULES.map((r) => `- ${r}`),
    "",
    "JORNADAS (o caminho certo de cada tarefa):",
    jornadas,
    "",
    "ARMADILHAS:",
    ...GOTCHAS.map((g) => `- ${g}`)
  ].join("\n");
}
