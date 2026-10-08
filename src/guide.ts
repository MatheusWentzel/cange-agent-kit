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
      "cange map: devolve em UMA chamada, resumido, os flows acessíveis, os campos do formulário de criação (startFields) e cada etapa (id, nome) com os campos dela (título, tipo, obrigatório, opções quando até 8, vínculo).",
      "cange map --flow-id <f>: um flow só. Rode UMA vez por run e reaproveite (não repita o mapa).",
      "Com o mapa em mãos: campo em startFields é do form de CRIAÇÃO; campo em steps[].fields é campo daquela ETAPA (--full traz o formId de cada um)."
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
      "cange card read --card-id <c> --fields \"<título>,<título>\": SÓ os campos que você precisa, inteiros. Prefira assim.",
      "cange card read --flow-id <f> --card-id <c>: o cartão inteiro, enxuto (fields [{id, title, value}]; valor acima de 600 caracteres sai cortado com a dica do --fields). Já leu? Não leia de novo: use o que tem.",
      "Vários cards do MESMO flow: cange card read --flow-id <f> --card-ids <a,b,c> (até 30) — 1 comando lê o lote inteiro; NUNCA um comando por card.",
      "cange card get --flow-id <f> --card-id <c> — só quando precisar do `raw` completo (pesado: pode passar de 700 KB)."
    ],
    pitfall:
      "NÃO parseie o `raw` do card get para achar valores — os valores legíveis já vêm prontos no `card read` (fieldValues; multi-valor vira array). " +
      "Registro ATIVO vs deletado: a verdade é o campo `deleted` (\"N\"=ativo, \"S\"=deletado); NÃO use `dt_deleted` (vem preenchido em ativos)."
  },
  {
    id: "navegar_vinculos",
    title: "Navegar vínculos entre cards (pai ⇄ filhos)",
    when: "o card se relaciona com cards de outros flows (ex.: Pedido → Itens, Pedido → Fornecedores) e você precisa achar os ids do outro lado",
    steps: [
      "PAI → FILHOS: `cange card read --flow-id <f> --card-id <pai>` — o bloco `links` traz, por field de vínculo (COMBO_BOX_FLOW_FIELD), a lista completa [{cardId, label}] dos cards apontados.",
      "FILHO → PAI: `cange card relationship --flow-id <flowDoVinculo> --card-id <filho>` — devolve os cards que referenciam o filho.",
      "Depois leia cada card do outro lado com `cange card read`."
    ],
    pitfall:
      "NÃO baixe o `card get` (raw de 1 MB+) do pai só para achar os filhos — o `links` do card read já traz todos os ids. O fieldValues sozinho não basta para vínculo multi-valor."
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
    id: "vencimento_responsavel_etiqueta",
    title: "Mudar vencimento, responsável ou etiqueta de um cartão",
    when: "o pedido é trocar a data de vencimento, quem é o responsável ou pôr/tirar uma etiqueta do cartão",
    steps: [
      "cange card update --card-id <c> --due 27/10/2026 (aceita dd/mm/aaaa com hora opcional, dd/mm, hoje, amanhã; `limpar` tira o vencimento).",
      "cange card update --card-id <c> --responsible <nome|e-mail|id|eu> (`ninguém` tira). Vencimento e responsável podem ir no mesmo comando.",
      "cange card update --card-id <c> --add-tag \"<etiqueta>\" (ou --remove-tag; uma etiqueta por comando, sempre separado do vencimento e do responsável).",
      "cange card read --card-id <c> (para conferir: due, responsible e tags sempre vêm, null ou [] quando vazio)."
    ],
    pitfall:
      "Não monte payload nem procure o fluxo: o comando acha o fluxo pelo cartão. O kit não cria etiqueta; se ela não existe, a mensagem lista as do fluxo."
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
    id: "criar_card",
    title: "Criar um card num fluxo",
    when: "precisa inserir um item/registro novo num fluxo (ex.: itens de cotação, marcos, tarefas)",
    steps: [
      "cange template flow-create --flow-id <f> — devolve o payloadSkeleton com os HASHES dos campos do form de criação (obrigatórios = <TIPO>; opcionais = <OPTIONAL:TIPO>).",
      "Monte o payload .json a partir do skeleton: preencha os obrigatórios E os opcionais que a tarefa pede; remova só o que não se aplica. Campo de register = [entryId] (ache com `register entries --register-id <r> --search`, ou pelo registerLinks de um card read).",
      "1 card: cange card create --payload <arq> — saída enxuta {cardId, stepId, createdAt}.",
      "2+ cards: SEMPRE em LOTE — cange card create --payload-dir <dir> (um .json por card) ou --payloads <a.json,b.json>. NUNCA um loop de shell chamando card create N vezes: a rajada estoura o rate limit, a chave é bloqueada por 5 min e os creates seguintes falham.",
      "Confira o retorno do lote: {requested, created, failed, notAttempted, cardIds}. Os cards que EXISTEM são os de cardIds — exit 5 significa lote INCOMPLETO.",
      "Se o card criado precisa aparecer num campo de vínculo de OUTRO card (pai), grave o vínculo lá (ver jornadas navegar_vinculos e gravar_campo_etapa) — criar NÃO vincula sozinho."
    ],
    pitfall:
      "Chaves de values são os HASHES (name) dos campos — id numérico é traduzido automaticamente, mas o canônico é o hash do template. NUNCA envie um placeholder literal (<...>) no payload. " +
      "E NUNCA monte vínculo/contagem com id que o create não devolveu: num lote que falhou no meio, os ids que faltam NÃO são a continuação da sequência (caso real: 8 ids inexistentes vinculados como se existissem)."
  },
  {
    id: "gravar_campo_etapa",
    title: "Gravar campo de ETAPA sem mover o card",
    when: "precisa escrever num campo que pertence ao form de uma etapa (não ao form de criação) sem mudar o card de etapa",
    steps: [
      "Descubra a etapa dona do campo: `cange map --flow-id <f>` (o campo aparece em steps[].fields da etapa).",
      "cange card update-values --payload <arq.json> com { flowId, cardId, idForm: <FORM DA ETAPA>, values: {\"<hash>\": <valor>} } — o endpoint aceita qualquer form do flow.",
      "NÃO use --validate-fields neste caso: a validação client-side compara com o form de criação e daria falso UNKNOWN_FIELD."
    ],
    pitfall:
      "NUNCA use self-move (move com from==to) para gravar campo de etapa: cada move cria um form_answer novo e pode sobrepor snapshot preenchido. `update-values` com o idForm da etapa é o caminho canônico."
  },
  {
    id: "mover_card",
    title: "Mover um card de etapa",
    when: "avançar o card para outra etapa do fluxo",
    steps: [
      "cange card move --card-id <c> --to \"<etapa de destino>\" --set \"Campo=valor\" (1 passo: a origem é a etapa atual do cartão; o --set grava campos da etapa atual dentro do próprio mover).",
      "Mover exige os obrigatórios da etapa atual (regra da plataforma, igual à tela). Se o pedido não traz os valores, pergunte ao usuário antes de mover; faltou, o kit não grava (exit 2) e devolve o comando pronto com os --set que faltam.",
      "Avançado: cange template step-move --flow-id <f> --from-step-id <origem> --to-step-id <destino> --card-id <c> gera o payloadSkeleton para `card move-step-with-values --payload <arquivo.json>`."
    ],
    pitfall:
      "Não invente valor de obrigatório para passar da validação. O obrigatório da etapa de DESTINO não é cobrado ao entrar (vale quando o cartão sair de lá). O template exige --from-step-id E --to-step-id (não existe --step-id)."
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
    id: "contar_somar",
    title: "Contar ou somar cartões (quantos por etapa, total de um valor)",
    when: "a tarefa pede contagem, total, soma ou distribuição de cartões de um fluxo",
    steps: [
      "cange cards count --flow-id <f> [--by etapa | --by campo:\"<título>\"] [--where \"<campo>=<valor>\"]: {total, groups}, só cartões ativos.",
      "cange cards sum --flow-id <f> --field \"<título numérico>\" [--by etapa] [--where ...]: {total, cards, groups}."
    ],
    pitfall:
      "NÃO liste os cartões para contar ou somar com python/jq: a lista pagina em 20 e o cálculo na mão erra e custa caro. `cards count`/`cards sum` já devolvem o número."
  },
  {
    id: "ler_cadastro",
    title: "Ler as entradas de um cadastro (register)",
    when: "listar registros (clientes, produtos, fornecedores…)",
    steps: [
      "cange my-registers — ache o cadastro e seu id.",
      "cange register entries --register-id <r> — lê as entradas (roteia engine v1/v2 sozinho; use `--search` para filtrar). `fieldTitles` lista todos os campos do cadastro: campo que não aparece na entrada está VAZIO.",
      "cange register entries --register-id <r> --fields \"<título>,<título>\" (só esses campos, na ordem, null quando vazio).",
      "cange register entries --entry-id <id> (uma entrada com todos os campos, null = vazio; o cadastro sai da entrada)."
    ],
    pitfall: "O valor solto não vira id: `register entries 183` é erro; use --register-id 183 (ou --entry-id para uma entrada)."
  }
];

/** Regras de ouro — valem em quase toda interação de escrita/leitura. */
export const GOLDEN_RULES: string[] = [
  "Comece pelo MAPA: `cange map` dá flows + etapas + campos + vínculos em 1 chamada — não reconstrua o ambiente na unha.",
  "Ler card: `cange card read --fields \"<títulos>\"` com só os campos que precisa (ou `card read` inteiro, enxuto); `card get` (com raw pesado) só quando precisar da estrutura crua. Não releia o mesmo cartão sem motivo.",
  "Contar ou somar: `cange cards count` / `cange cards sum` (não python/jq sobre a lista). Listas vêm em páginas de 20 com `total` e `next`.",
  "MUTAÇÃO com `--payload` recebe o CAMINHO de um arquivo .json, NUNCA JSON inline. Vencimento, responsável e etiqueta não precisam de arquivo: `card update --card-id <c> --due|--responsible|--add-tag`. Leitura usa flags diretas.",
  "Em `values`, a chave é o `id`/`name` do field (de `fields by-flow`/`step-form`), e o valor de um campo de opção é o CÓDIGO (`value`), não o texto.",
  "Ler texto de campo: use `valueString`; `value` costuma ser só o código da opção.",
  "Registro ativo vs deletado: olhe o campo `deleted` (\"N\"/\"S\"), não `dt_deleted`.",
  "Anexo: SEMPRE `cange attachment download`, NUNCA curl no blob cru.",
  "Campo do form de criação → `card update-values`; campo de ETAPA → `card move-step-with-values`.",
  "Ids em flags e payloads: use o padrão `--flow-id`/`--card-id`/`--register-id`; nos payloads, ids numéricos (string numérica também é aceita).",
  "Vários itens = LOTE em 1 comando (`card create --payload-dir`, `card read --card-ids`), nunca um loop de shell: a API bloqueia a chave por 5 minutos quando a rajada estoura o teto (10 req/s leitura, 20 req/s escrita).",
  "Depois de QUALQUER mutação, o que existe é o que o comando DEVOLVEU. Exit 5 = lote incompleto: use só os ids retornados, reprocesse o que faltou e, se não fechar, reporte a tarefa como parcial."
];

/** Armadilhas do ambiente headless do runner (queimam turno se ignoradas). */
export const GOTCHAS: string[] = [
  "Ambiente headless: prefira Node (`node -e`), Read/Grep e o CLI `cange`. `python3`/`jq`/`file` existem como fallback; `timeout` NÃO existe.",
  "Todo comando com exit != 0 vira 'ação que falhou' no log da execução. Antes de ler um arquivo que pode não existir, use `[ -f <path> ] && cat <path> || echo ausente` — não `cat` direto.",
  "Exit 5 é SUCESSO PARCIAL de lote (parte processada, parte não) — não é sucesso nem falha total: leia o resumo em stdout e reprocesse o que faltou antes de concluir a tarefa.",
  "Kit SEMPRE, MCP NUNCA: use o CLI `cange` (autentica como você). Nunca use um conector MCP do Cange — ele autentica como outro usuário e quebra fila/auditoria.",
  "Erro de uso (exit 2) com `suggestion` (\"Você quis dizer: cange ...\"): rode o comando sugerido. Sem sugestão, a mensagem lista as opções do comando; só então consulte `cange <comando> --help` ou `cange manifest --output json`. Não tente às cegas.",
  "Exit 6 = a ferramenta de API (`cange tool call`) falhou: o serviço externo recusou ou não respondeu. Conte como falha na resposta, com o nome e o motivo. Não busque o dado em outra fonte (site, outra API) por conta própria; só vale tentar outra ferramenta de API cadastrada com a mesma finalidade, uma vez.",
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
