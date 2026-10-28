import { extname, isAbsolute, resolve } from "node:path";

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

/**
 * Onda 4 (B3): o exemplo de arquivo de uma receita. Com `--file`, o kit põe o caminho no
 * lugar dele. `ext` limita ao tipo (o exemplo de pdf não recebe um docx).
 */
interface RecipeFileExample {
  example: string;
  ext?: string;
}

interface Recipe {
  title: string;
  lines: readonly string[];
  files?: readonly RecipeFileExample[];
}

export const RECIPES: Readonly<Record<string, Recipe>> = Object.freeze({
  anexo: {
    title: "Ler um anexo do cartão (proposta, documento, comprovante)",
    files: [
      { example: '"<arquivo>.docx"', ext: ".docx" },
      { example: "<arquivo>.pdf", ext: ".pdf" }
    ],
    lines: [
      "1) Veja os arquivos do cartão: `cange attachment list --card-id <id> --name \"<o que a pessoa disse>\"`. Procura nos",
      "   campos de anexo E na colaboração (comentários); `files` diz de onde vem cada um. Um candidato: use direto. Veio",
      "   `ask` (mais de um, ou nenhum com o nome dito): pergunte à pessoa com essa frase antes de baixar.",
      "   Sem `--name` é só a lista (nunca `ask`). Automação ou rotina (ninguém para responder): não pergunte; use o arquivo",
      "   do campo de anexo que a instrução cita (o mais recente, se nada indicar) e diga no comentário qual usou.",
      `2) Baixe pelo comando (rota autenticada): \`cange attachment download --card-id <id> --attachment-id <id> --out ${RUN_FOLDER}/anexos\``,
      "   (`--from comentarios`, `--from campos` ou `--from todos` baixa por origem). NUNCA baixe com curl na URL do blob: dá 404 ou 403.",
      "3) PDF ou DOCX: NUNCA use `Read` no arquivo binário (vira base64 e explode o contexto; 1,5 MB num run real).",
      "   Extraia o TEXTO primeiro e leia o .txt:",
      `   - docx: \`unzip -p "<arquivo>.docx" word/document.xml | perl -pe 's/<\\/w:p>/\\n/g; s/<[^>]+>//g' > ${RUN_FOLDER}/doc.txt\``,
      `   - pdf: \`pdftotext <arquivo>.pdf ${RUN_FOLDER}/doc.txt\` (sem pdftotext: \`python3 -c "import pypdf; ..."\`)`,
      "4) Planilha (xlsx/csv): leia com python3 e imprima só o resumo que a tarefa pede, nunca o arquivo inteiro."
    ]
  },
  "enviar-anexo": {
    title: "Pôr um arquivo no cartão (comentário ou campo de anexo)",
    files: [{ example: `${RUN_FOLDER}/<arquivo>` }],
    lines: [
      `1) Grave o arquivo na pasta desta execução (${RUN_FOLDER}), com caminho completo. Arquivo de fora dela, com "..",`,
      "   ou link para fora é recusado. Limite: 25 MB.",
      `2) Suba: \`cange attachment upload --file ${RUN_FOLDER}/<arquivo>\`. Devolve o \`attachmentId\`; o arquivo ainda não`,
      "   aparece para ninguém.",
      "3) Ponha no cartão, em outro comando:",
      '   - num comentário: `cange comment create --card-id <id> --text "<texto>" --attachment-id <attachmentId>`;',
      '   - num campo de anexo: `cange attachment link-field --card-id <id> --field "<campo>" --attachment-id <attachmentId>`',
      "     (soma aos arquivos que o campo já tem; o campo pode aceitar só alguns tipos, veja em `attachment list`).",
      "Este passo 3 usa a permissão Anexos e pode pedir aprovação: é o mesmo comando depois de aprovado (o attachmentId",
      "não muda, não suba de novo). Um anexo que já está no cartão também pode ir para outro comentário ou campo dele."
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
      "- Mover exige os obrigatórios da etapa atual (regra da plataforma, igual à tela). Mande-os no MESMO comando com",
      "  `--set`; se não estão no pedido, pergunte ao usuário (não invente). Faltou: nada é gravado (exit 2) e a",
      "  mensagem diz quais campos e traz o comando pronto com os `--set` que faltam.",
      "- `--set` aceita campo da etapa atual, da etapa de destino ou do formulário inicial: o kit manda cada um para",
      "  o lugar certo e reenvia o que o cartão já tem na etapa atual (nada some).",
      "- Quer conferir antes? O mesmo comando com `--dry-run` mostra as chamadas e o que falta, sem gravar.",
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
    files: [{ example: `${RUN_FOLDER}/artefato-20260930-1432.html`, ext: ".html" }],
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
      "4) 404 ou \"sem acesso\": o erro traz `hint` com o `cange access request` pronto (tipo e id do comando); siga-o.",
      "   Sem o id: `cange catalog --type register --q <nome do cadastro>` e, com access \"não\",",
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

/** Caminho no shell: sem aspas quando não precisa, senão entre aspas simples. */
function shellPath(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * O caminho por extenso: o marcador da pasta do run vira o TMPDIR, e o relativo vira
 * absoluto (o gate recusa caminho relativo e o marcador copiado ao pé da letra).
 */
function absoluteFile(file: string, scratch: string | undefined, cwd: string): string {
  const text = file.trim();
  if (text.startsWith(RUN_FOLDER)) return scratch ? `${scratch}${text.slice(RUN_FOLDER.length)}` : text;
  return isAbsolute(text) ? text : resolve(cwd, text);
}

/**
 * Texto da receita (com a pasta do run na 1ª linha quando o TMPDIR existe). Com `file`, o
 * caminho entra no lugar do exemplo de arquivo da receita (onda 4, B3).
 */
export function renderRecipe(
  name: string,
  env: Record<string, string | undefined> = process.env,
  file?: string,
  cwd: string = process.cwd()
): string {
  const recipe = RECIPES[name];
  if (!recipe) {
    throw new CangeCliUsageError(
      `Receita "${name}" não existe. Receitas: ${recipeNames().join(", ")} (ex.: \`cange recipe anexo\`).`
    );
  }
  const rawScratch = env.TMPDIR?.trim();
  const scratch = rawScratch && rawScratch.startsWith("/") ? rawScratch.replace(/\/+$/, "") : undefined;
  let lines = [...recipe.lines];
  const header: string[] = [];
  if (file !== undefined && file.trim() !== "") {
    const path = absoluteFile(file, scratch, cwd);
    const ext = extname(path).toLowerCase();
    let placed = false;
    for (const { example, ext: only } of recipe.files ?? []) {
      if (only !== undefined && only !== ext) continue;
      if (!lines.some((line) => line.includes(example))) continue;
      lines = lines.map((line) => line.split(example).join(shellPath(path)));
      placed = true;
    }
    header.push(placed ? `ARQUIVO = ${path} (já está nos comandos abaixo)` : `ARQUIVO = ${path}`);
  }
  return [
    `# ${recipe.title}`,
    ...(scratch ? [`PASTA_DO_RUN = ${scratch} (troque ${RUN_FOLDER} por este caminho, escrito por extenso)`] : []),
    ...header,
    ...lines
  ].join("\n");
}

export function registerRecipeCommand(program: Command): void {
  const command = program
    .command("recipe")
    .description(`Receita pronta de uma ação sob demanda (${recipeNames().join(", ")})`)
    .argument("[nome]", `Nome da receita: ${recipeNames().join(" | ")}`)
    .argument("[arquivo]", "O mesmo que --file")
    .option("--file <arquivo>", "Arquivo da tarefa: a receita sai com o caminho dele no lugar do exemplo")
    .action(
      createCommandAction(
        async (_ctx, name: string | undefined, positional: string | undefined, options: { file?: string }) => {
          if (options.file !== undefined && positional !== undefined && options.file !== positional) {
            throw new CangeCliUsageError(
              "Passe o arquivo uma vez só: `cange recipe <nome> --file <arquivo>` (ou o caminho logo depois do nome)."
            );
          }
          const file = options.file ?? positional;
          const text = name
            ? renderRecipe(name.trim().toLowerCase(), process.env, file)
            : `Receitas: ${recipeNames().join(", ")}. Uso: \`cange recipe <nome> [--file <arquivo>]\`.`;
          process.stdout.write(`${text}\n`);
          return undefined;
        },
        { requiresAuth: false }
      )
    );

  annotateCommand(command, {
    envelope: "texto cru (não JSON): a receita, com a pasta do run na 1ª linha quando o TMPDIR existe",
    fieldsLocation: "stdout inteiro é a receita",
    example: "cange recipe anexo --file anexos/proposta.pdf"
  });
}
