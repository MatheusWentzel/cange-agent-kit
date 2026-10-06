import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

/**
 * `cange recipe <nome>` — receitas SOB DEMANDA (rodada 5, 01/10).
 *
 * O bloco do CLI que o runner põe no system prompt de todo agente é relido a cada
 * chamada à API. As receitas de escrita que o agente NÃO tem liberadas (e a receita
 * rara do anexo) saíram dele: quem precisa lê aqui, uma vez, no run em que precisa.
 * O caminho da pasta do run é o marcador `<PASTA_DO_RUN>`, como no system prompt;
 * com TMPDIR no ambiente (o runner aponta para a pasta do run), a 1ª linha diz qual é.
 *
 * O texto sai CRU (não JSON): é instrução para ler, não dado para processar.
 */
const RUN_FOLDER = "<PASTA_DO_RUN>";

export const RECIPES: Readonly<Record<string, { title: string; lines: readonly string[] }>> = Object.freeze({
  anexo: {
    title: "Ler um anexo do cartão (proposta, documento, comprovante)",
    lines: [
      `1) Baixe pelo comando (rota autenticada): \`cange attachment download --flow-id <id> --card-id <id> --out ${RUN_FOLDER}/anexos\`.`,
      "   O anexo vive num CAMPO do cartão (tipo anexo), não na colaboração nem no relacionamento.",
      "   NUNCA baixe com curl na URL do blob (Azure): dá 404 ou 403.",
      "2) PDF ou DOCX: NUNCA use `Read` no arquivo binário (vira base64 e explode o contexto; 1,5 MB num run real).",
      "   Extraia o TEXTO primeiro e leia o .txt:",
      `   - docx: \`textutil -convert txt <arquivo>.docx -output ${RUN_FOLDER}/doc.txt\``,
      `   - pdf: \`pdftotext <arquivo>.pdf ${RUN_FOLDER}/doc.txt\` (sem pdftotext: \`python3 -c "import pypdf; ..."\`)`,
      "3) Planilha (xlsx/csv): leia com python3 e imprima só o resumo que a tarefa pede, nunca o arquivo inteiro."
    ]
  },
  comentar: {
    title: "Comentar num cartão (só com \"Comentar\" liberado)",
    lines: [
      "Um comando só, sem arquivo: `cange comment create --card-id <id> --text \"<texto em markdown>\"`.",
      "O grupo é `comment` e o subcomando é `create`: não existe `cange comment` sozinho nem `cange card comment`.",
      "Não precisa do fluxo: sem `--flow-id`, o kit descobre pelo número do cartão (a saída mostra em `resolved`).",
      "Para avisar alguém, use `--mention` (receita `mencionar`).",
      "Avançado: `--payload <arquivo.json>` com `{ \"cardId\": <id>, \"description\": \"...\", \"mentions\": [] }` continua valendo."
    ]
  },
  mencionar: {
    title: "Mencionar alguém num comentário (a pessoa recebe a notificação)",
    lines: [
      "`cange comment create --card-id <id> --text \"Proposta pronta, @Ana confere?\" --mention \"Ana Souza\"`",
      "`--mention` aceita id, e-mail ou nome do usuário e é repetível (uma pessoa por flag).",
      "O kit faz as duas coisas que a tela faz: manda o id em `mentions` (gera a notificação) e marca `@[Nome](id)` no texto.",
      "Se o texto já tem `@Ana`, ele vira a marcação; se não tem, a marcação entra no começo do texto.",
      "Nome ambíguo ou inexistente: o comando não grava e lista os candidatos (use o e-mail ou o id).",
      "Confira antes, se quiser: o mesmo comando com `--dry-run` mostra o texto e os `mentions` resolvidos."
    ]
  },
  "criar-card": {
    title: "Criar um cartão num fluxo (só com \"Criar card\" liberado)",
    lines: [
      "1) Fluxo: pelo id que você já tem, ou `cange my-flows` e escolha pelo nome (ambíguo: pergunte).",
      "2) Um comando só, sem arquivo: `cange card create --flow-id <id> --set \"Título=Pedido ACME\" --set \"Valor=R$ 2.500,00\"`.",
      "   O campo pode ser o TÍTULO (como aparece na tela, sem diferença de maiúscula ou acento), o id ou o hash.",
      "   O valor vai como você leria: número \"2.500,00\", data \"06/10/2026\", opção pelo rótulo, usuário pelo e-mail,",
      "   cadastro pelo nome da entrada. O kit converte e, se algo não servir, diz tudo de uma vez sem gravar (exit 2).",
      "3) Quer conferir antes? O mesmo comando com `--dry-run` mostra o payload resolvido e os obrigatórios que faltam.",
      "Avançado: `--payload <arquivo.json>` continua valendo (e `--payload-dir` para lote de 2+ cartões)."
    ]
  },
  "mover-card": {
    title: "Mover um cartão de etapa (só com \"Mover card\" liberado)",
    lines: [
      "Um comando só: `cange card move --card-id <id> --to \"<etapa de destino>\" [--set \"Campo=valor\"]`.",
      "- A origem é a etapa ATUAL do cartão (o kit lê); o destino vai pelo nome ou pelo id da etapa.",
      "- `--set` aceita campo da etapa atual, da etapa de destino ou do formulário inicial: o kit manda cada um para",
      "  o lugar certo e reenvia o que o cartão já tem na etapa atual (nada some).",
      "- Para checar os obrigatórios da etapa atual antes de mover, use `--validate-fields` (ou `--dry-run` para só ver).",
      "- Só gravar campos, sem mover: `cange card update-values --card-id <id> --set \"Campo=valor\"`.",
      "  Nunca mova o cartão para a própria etapa para gravar campo.",
      "Avançado: `cange card move-step-with-values --payload <arquivo>` (idForm = form da etapa ATUAL)."
    ]
  },
  "gravar-campos": {
    title: "Gravar campos de um cartão sem mover (só com \"Atualizar card\" liberado)",
    lines: [
      "`cange card update-values --card-id <id> --set \"Valor do Negócio=2.500,00\" --set \"Data da ligação=06/10/2026\"`",
      "- O campo pode ser o título, o id ou o hash; o kit acha o formulário (etapa atual ou inicial) pelo campo.",
      "- Valor como na tela: número com vírgula, data dd/mm/aaaa, opção pelo rótulo, usuário pelo e-mail ou nome,",
      "  cadastro pelo nome da entrada (ou a lista de ids).",
      "- Vários campos de uma vez: `--values-json '{\"Valor do Negócio\": \"2.500,00\", \"Etapa\": \"Fechado\"}'`."
    ]
  },
  "publicar-artefato": {
    title: "Publicar um artefato (página HTML; só com \"Publicar artefato\" liberado)",
    lines: [
      `1) Grave o HTML num arquivo da pasta do run (ex.: \`${RUN_FOLDER}/artefato-20260930-1432.html\`).`,
      "2) Em OUTRO comando, sozinho:",
      `   - no cartão do run: \`cange artifact publish --card-id <id> --type <slug> --title '<título por extenso>' --file ${RUN_FOLDER}/artefato-20260930-1432.html\`;`,
      `   - no chat sem cartão em foco: o mesmo comando SEM \`--card-id\` (o kit usa a conversa).`,
      "3) Republicar o mesmo `--type` no mesmo dono vira NOVA VERSÃO do mesmo artefato. Antes, confira com o MESMO",
      "   comando e `--dry-run`: aviso em `warnings` = aquele trecho NÃO entrou."
    ]
  },
  "cadastro-por-nome": {
    title: "Achar uma entrada de cadastro pelo nome (ex.: o cliente ACME no cadastro Clientes)",
    lines: [
      "1) Id do cadastro: use o da sua cabeça ou do pedido. Link do Cange ou hash servem direto em `--register-id`",
      "   (o kit troca pelo id). Sem nada: `cange my-registers --q <nome do cadastro>`.",
      "2) `cange register entries --register-id <id> --search <parte do nome>` (`--q` é sinônimo de `--search`).",
      "   Busque por uma parte curta do nome; veio muita coisa: refine o texto ou use `--page-size 50`.",
      "3) O `id` de cada item em `entries` é o id da entrada. Para gravar num campo de cadastro do cartão, o `--set`",
      "   aceita o nome da entrada (`--set \"Cliente=ACME\"`, o kit busca e recusa se casar com 0 ou 2+) ou o id.",
      "4) 404 ou \"sem acesso\": `cange catalog --type register --q <nome do cadastro>` e, com access \"não\",",
      "   `cange access request --register <id> --reason \"<para que precisa>\"`. Não existe `cange search`."
    ]
  },
  "contar-somar": {
    title: "Contar ou somar cartões de um fluxo (sem python)",
    lines: [
      "Contar: `cange cards count --flow-id <id> [--by etapa | --by campo:\"<título>\"] [--where \"<campo>=<valor>\"]`.",
      "Somar: `cange cards sum --flow-id <id> --field \"<título do campo numérico>\" [--by etapa] [--where ...]`.",
      "- Saída: `{total, groups:[{key, count}]}` (no sum: `{total, cards, groups:[{key, sum}]}`). Só cartões ativos (não arquivados",
      "  nem excluídos) e só os que você enxerga.",
      "- `--where` repete (todos valem): `--where \"Prioridade=Alta\" --where \"etapa=Em execução\"`; `!=` nega; valor vazio = `(vazio)`.",
      "- Campo pelo título (sem diferença de maiúscula ou acento), id ou hash; título repetido = erro com os ids (use o id).",
      "NÃO liste os cartões para contar ou somar com python/jq: a lista vem em páginas de 20 e o cálculo na mão erra e custa caro."
    ]
  },
  "ler-campos": {
    title: "Ler só os campos que precisa de um cartão",
    lines: [
      "`cange card read --card-id <id> --fields \"Valor do Negócio,Data da ligação\"`: só esses campos, com o valor inteiro e legível.",
      "- Campo pelo título (sem diferença de maiúscula ou acento), id ou hash, separados por vírgula. Vale no lote (`--card-ids`).",
      "- Sem `--fields` vem o cartão inteiro e valor acima de 600 caracteres sai cortado com a dica `use --fields \"<campo>\"`.",
      "- Para REESCREVER um rich text, leia o original (HTML) com `--field-ids <id>`; o `--fields` devolve markdown.",
      "- Já leu o cartão neste run? Use o que tem; não leia de novo sem motivo (cada leitura volta ao contexto em todo turno)."
    ]
  }
});

export function recipeNames(): string[] {
  return Object.keys(RECIPES);
}

/** Texto da receita (com a pasta do run na 1ª linha quando o TMPDIR existe). */
export function renderRecipe(name: string, env: Record<string, string | undefined> = process.env): string {
  const recipe = RECIPES[name];
  if (!recipe) {
    throw new CangeCliUsageError(
      `Receita "${name}" não existe. Receitas: ${recipeNames().join(", ")} (ex.: \`cange recipe anexo\`).`
    );
  }
  const scratch = env.TMPDIR?.trim();
  return [
    `# ${recipe.title}`,
    ...(scratch && scratch.startsWith("/")
      ? [`PASTA_DO_RUN = ${scratch.replace(/\/+$/, "")} (troque ${RUN_FOLDER} por este caminho, escrito por extenso)`]
      : []),
    ...recipe.lines
  ].join("\n");
}

export function registerRecipeCommand(program: Command): void {
  const command = program
    .command("recipe")
    .description(`Receita pronta de uma ação sob demanda (${recipeNames().join(", ")})`)
    .argument("[nome]", `Nome da receita: ${recipeNames().join(" | ")}`)
    .action(
      createCommandAction(
        async (_ctx, name: string | undefined) => {
          const text = name
            ? renderRecipe(name.trim().toLowerCase())
            : `Receitas: ${recipeNames().join(", ")}. Uso: \`cange recipe <nome>\`.`;
          process.stdout.write(`${text}\n`);
          return undefined;
        },
        { requiresAuth: false }
      )
    );

  annotateCommand(command, {
    envelope: "texto cru (não JSON): a receita, com a pasta do run na 1ª linha quando o TMPDIR existe",
    fieldsLocation: "stdout inteiro é a receita",
    example: "cange recipe anexo"
  });
}
