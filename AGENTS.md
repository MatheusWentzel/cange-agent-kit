# AGENTS.md - cange-agent-kit

Este projeto existe para ser a camada segura entre agentes e a API do Cange.

## Regras operacionais obrigatórias

- Nunca chamar `curl` direto se houver comando da CLI disponível.
- Sempre preferir discovery antes de mutações.
- Para qualquer payload com `values`, consultar primeiro a estrutura de fields.
- A chave de `values` é sempre `field.name`.
- O valor enviado deve respeitar `field.type`.
- Na criação, preencher todos os campos com `required = "1"` do formulário-alvo.
- Para card create, usar `flow.form_init_id`.
- Para register create/update, usar `register.form_id`.
- Para register create, o payload precisa do `registerId` (id do cadastro) **na raiz**, além do `idForm`: o backend resolve a referência por `register_id` no body. Sem ele, 404 "não foi possível encontrar a referência do formulário" — que parece falta de acesso, mas é payload. No register update, mandar `registerId` junto do `formAnswerId`.
- Para mover etapa de card, usar `card move --card-id <id> --to <etapa>` (ou `card move-step-with-values`, que sem `--payload` é o mesmo).
- Quando não houver campos para preencher, enviar `values: {}`.
- Ao mover etapa com `--payload`, o `idForm` do payload deve ser o `form_id` da etapa atual (`flow_step.form_id`), não o `form_init_id` do fluxo, e os `values` só desse formulário (o `card move` separa os formulários sozinho).
- **Mover exige os obrigatórios da etapa atual; peça os valores ao usuário se não estiverem no pedido** (decisão do
  Matheus, 06/10/2026: regra base da plataforma, igual à tela). O kit cobra SEMPRE, em todo caminho de mover
  (`card move`, `card move-step-with-values` com ou sem `--payload`, `card move-step`), com ou sem `--validate-fields`
  e `--dry-run`. Faltou: exit `2`, nada gravado, e a mensagem traz o comando pronto para gravar e mover no mesmo passo
  (`card move ... --set "Campo=valor"`: o campo da etapa atual vai dentro do próprio mover). Não invente valor para
  passar da validação. Exceção, igual à tela: VOLTAR etapa num fluxo com "pular obrigatórios ao voltar" ligado.
  Os obrigatórios da etapa de destino não são cobrados ao entrar (valem quando o cartão sair de lá).
  Também igual à tela: campo oculto no formulário (`show_on_form = "S"`) não é cobrado. Obrigatório com condicional
  ("Exibir/Esconder campo") não bloqueia, porque a tela só o exige quando a condicional exibe o campo e o kit não avalia
  condicionais: vazio, ele volta em `warning` no resultado (e na dica, quando outro obrigatório bloqueia). Se o campo
  aparece para o cartão, mande o valor com `--set` no mesmo mover. Check list "exigir todos concluídos" com item sem
  marcar bloqueia sempre, mesmo oculto ou com condicional (a tela confere todos).
- Ao mover etapa, **os campos já preenchidos são preservados pelo kit**: o move grava um form_answer NOVO só com o que vier em `values` e o back apaga o rascunho da etapa (o que a tela, as automações e o `card update-values` deixam nele). O kit lê o que o cartão tem na etapa atual pela mesma fonte da tela (`GET /form/pre-answer`: rascunho ou última passagem; entre rascunho e confirmada vence a linha editada por último, e só a linha da confirmada escrita desde a entrada do cartão na etapa; linha repetida no rascunho vale uma vez, a primeira) e reenvia no mover, no `card move` e no `--payload` que grava a etapa atual (o `values` vence). Campo vazio com autocompletar recebe o valor que a tela poria (saída `autocompleted`; inclui a opção pelo rótulo, o texto da origem casado com o rótulo da opção); com a origem do autocompletar vazia no cartão a tela não preenche nada e o kit cobra o obrigatório igual, salvo o vínculo cuja origem (cadastro ou cartão do mesmo formulário) vai no próprio mover: a tela preenche no blur e o kit pede o mesmo valor; o autocompletar com origem no cartão (vínculo de cadastro ou cartão, cópia de anexo, opção pelo rótulo) vem do mesmo `POST /form/answers/by-cards` que a tela faz ao abrir o cartão; o que o kit não calcula (usuário atual, by-cards que falhou) volta em `warning`, obrigatório ou não. Valor gravado que a tela não mostra conta como vazio, como no componente da tela: usuário bloqueado, leitor do fluxo ou fora do fluxo privado (a lista do campo), cartão conectado excluído, opção apagada ou "none" no combo, opção oculta no rádio e na caixa de marcação, item de check list sem descrição, anexo que não existe e documento ou telefone sem dígito; obrigatório assim bloqueia com o motivo ("está gravado no cartão, mas a tela mostra o campo vazio"), o resto sai do mover e volta em `warning`. Documento e telefone com formato que a tela recusa (CPF/CNPJ pelo dígito verificador e pela variation; telefone com 10 ou 11 dígitos) bloqueiam o mover mesmo fora do obrigatório e oculto, e o `--set` de qualquer escrita recusa igual (e o usuário fora da lista do campo). Anexo e botão que estão na pré-resposta também vão, como a tela manda (a lista de ids do anexo; o JSON do último clique). O que não dá para reenviar (fórmula, ID automático, anexo fora da pré-resposta) volta em `warning`; `--fail-on-data-loss` bloqueia; obrigatório que o kit não consegue reenviar bloqueia sempre (o mover o deixaria vazio). O back apaga o rascunho do formulário que o mover GRAVA, qualquer que seja: no `--payload` com o form do destino (ou `idForm` omitido, que cai no destino; o kit resolve e mostra o `idForm` no dry-run) e no `card move` de etapa sem formulário, o kit reenvia o que a tela mostra nesse formulário (rascunho ou última passagem) com o `values` por cima. `--allow-data-loss` (só `--payload`) aceita perder só a etapa atual (não reenvia o que o cartão tem nela, ou deixa sumir o rascunho dela ao gravar outro formulário); o rascunho do formulário gravado segue reenviado.
- **Nunca fazer self-move** (`fromStepId === toStepId`) para "criar"/preencher um form_answer: duplica o form_answer e o snapshot vazio mais recente sobrepõe o preenchido. Para apenas atualizar values sem mover, usar `card update-values`. O kit bloqueia self-move por padrão (`--allow-self-move` força).
- Usar `step-form --flow-id <id> --step-id <id>` para descobrir obrigatórios da etapa antes de montar payload.
- Para marcar notificação como lida/arquivada, usar `notification read`.
- Usar `template flow-create`, `template register-create` e `template step-move` antes de mutações quando necessário.
- Usar `--validate-fields` e `--dry-run` antes de mutações quando apropriado.
- Se `--validate-fields` falhar com `UNKNOWN_FIELD_TYPE`, omitir `--validate-fields` e executar apenas com `--dry-run`. Tipos não mapeados na validação local não impedem a mutação na API.
- `--payload` (avançado) sempre recebe caminho de arquivo JSON, nunca JSON inline. Valores inline: `--set` / `--values-json`.
- Inputs de mutação fora de `values` devem usar camelCase (`flowId`, `cardId`, `registerId` etc).
- Não inventar IDs.
- Não inventar chaves de `values`.
- Se houver falha de autenticação, revisar `CANGE_ACCESS_TOKEN` ou `CANGE_EMAIL` / `CANGE_APIKEY`.

## Formato da saída (padrão enxuto desde 01/10/2026)

- O padrão é a saída ENXUTA: JSON sem indentação (em pipe), sem campo nulo ou vazio, sem aliases snake_case
  (`id_card`, `flow_id`, `step_id`, `fields` duplicado), sem `raw` junto do resumo.
- `--full` (opção global, em qualquer posição) ou `CANGE_OUTPUT_PROFILE=full` devolve o formato COMPLETO de
  antes, byte a byte. `--raw`/`--raw-full` continuam crus.
- `CANGE_OUTPUT_PROFILE` e `CANGE_OUTPUT` valem tanto do ambiente do processo quanto do `.env` do diretório
  (o mesmo `.env` do token). Agente local ou script que lê o formato antigo (`raw` do `my-flows`,
  `summary.fields` do `card get`, `fieldValues` do `card read`) põe `CANGE_OUTPUT_PROFILE=full` no `.env` do
  clone ou no ambiente do processo. O ambiente do processo vence o `.env`.
- O que muda no enxuto:
  - `my-flows`: `summaries` [{id, title, formInitId, totalCards, access}] (sem `raw`);
  - `card read`: `fields` [{id, title, value}] com o título do campo; vínculo em `cards` [{cardId, label}] e
    cadastro em `entries` [{entryId, label}] dentro do campo; rich text em markdown, com `format: "markdown"`
    no campo convertido (`--field-ids` devolve o valor original, para reescrever);
  - `card list`: título real e `stepName` em cada cartão;
  - `comment list`: os 15 mais recentes, em markdown (`--limit <n>` traz mais; `total` diz quantos existem);
  - `map`: campos sem o hash `name` (o `values` aceita o id numérico do campo como chave em card create,
    update-values, move, add-child (também no `linkField`) e register create/update; o kit traduz para o hash
    antes de gravar e id inexistente falha sem gravar nada; `map --full` mostra o hash).
- Receitas sob demanda: `cange recipe <anexo|comentar|mencionar|criar-card|mover-card|gravar-campos|publicar-artefato|cadastro-por-nome|contar-somar|ler-campos>` (texto cru).

## Leitura menor: só o que precisa (desde 06/10/2026, card #1367459)

Em produção o contexto que cresce a cada turno é 45% do custo. Pesavam: ler o cartão inteiro (e reler o mesmo cartão),
calcular com python/jq sobre a saída do kit, ler o cadastro inteiro e repetir o `map`.

- **Para contar ou somar, use `cange cards count` / `cange cards sum` (não python/jq sobre a lista).**
  - `cange cards count --flow-id <id> [--by etapa | --by campo:"<título>"] [--where "<campo>=<valor>"]...`
    → `{total, groups:[{key, stepId?, count}]}`.
  - `cange cards sum --flow-id <id> --field "<título numérico>" [--by etapa | --by campo:"<título>"] [--where ...]`
    → `{total, cards, groups:[{key, stepId?, sum}], ignored?}` (`ignored` = cartões com valor que não é número).
  - Só cartões ATIVOS (não arquivados nem excluídos) e só os que o token enxerga. `--where` repete (todos valem),
    `!=` nega, `etapa=<nome ou id>` filtra a etapa. Campo pelo título, id ou hash (a mesma resolução das escritas).
  - Fonte: sem `--where` e agrupando por etapa (ou sem agrupar), o próprio back agrega (`POST /flow/v2/aggregations`,
    o do cabeçalho do Kanban); o resto lê os cartões paginados (V2 só com os campos necessários, ou V1) e agrega no kit.
    `truncated: true` = passou do teto (10 mil no agregador, 20 mil na leitura). `card count`/`card sum` são o mesmo.
- **Leia só os campos que precisa com `--fields`:** `cange card read --card-id <id> --fields "Valor do Negócio,Data da ligação"`
  (título sem diferença de maiúscula/acento, id ou hash; vale no lote `--card-ids`). Valor inteiro e legível (markdown).
  Sem `--fields`, valor acima de 600 caracteres sai cortado com `…(cortado: use --fields "<campo>" para ler inteiro)`.
  Para reescrever rich text, o original continua em `--field-ids <id>`. Não releia o mesmo cartão no mesmo run.
- **Listas em páginas:** `card list` (e `cards list`), `register entries` e `my-flows` trazem 20 por padrão, com o total
  (`totalCount` no card list, `total` nos outros) e `next` = o comando pronto da página seguinte (`--cursor`). `--limit` /
  `--page-size` mudam o tamanho. `register entries` não traz mais o `raw` e corta valor longo em 600 caracteres.
  `--full` mantém o formato de antes (lista inteira, com `raw`).
- **`map` resumido:** `startFields` (formulário de criação) e `steps[{id, name, fields}]`; campo = `{id, title, type,
  required? (só quando obrigatório), options? (rótulos, até 8) | optionsCount?, linksToFlowId?, registerId?}`. A lista
  longa de opções está em `cange fields by-flow` / `step-form`; o `formId` de cada campo, em `map --full`.
  Rode o `map` uma vez por run.
- **TOON (EXPERIMENTAL, desligado por padrão):** `--format toon` (opção global) ou `CANGE_OUTPUT_FORMAT=toon` imprime as
  LISTAS (`card list`, `register entries`, `my-flows`, `catalog`, `cards count/sum`) como tabela: escalares do envelope em
  `chave: valor`, depois `lista[N]{campo1,campo2}:` e uma linha por item, valores separados por vírgula (com vírgula,
  aspas ou quebra de linha, o valor vai entre aspas, escapado como JSON; objeto vira JSON). Os outros comandos e o
  `--full` seguem em JSON. O JSON padrão não muda.

## Escrita em 1 passo (padrão desde 06/10/2026)

O caminho padrão de toda escrita é UM comando, sem arquivo de rascunho. O `--payload <arquivo>` virou opção avançada.

- Criar: `cange card create --flow-id <id> --set "Título=Pedido ACME" --set "Valor=R$ 2.500,00"`
- Gravar campos sem mover: `cange card update-values --card-id <id> --set "Data da ligação=06/10/2026"`
  (o fluxo vem do link do cartão ou do ambiente do run; sem o fluxo, o kit descobre pelo número do cartão).
- Mover: `cange card move --card-id <id> --to "<etapa por nome ou id>" [--set "Campo=valor"]`
  (origem = etapa atual do cartão, lida pelo kit; `card move-step-with-values` sem `--payload` faz o mesmo).
  Mover exige os obrigatórios da etapa atual: mande-os no mesmo comando com `--set`; se não estiverem no pedido,
  pergunte ao usuário antes de mover.
- Comentar e mencionar: `cange comment create --card-id <id> --text "<texto>" [--mention <id|e-mail|nome>]...`
  (a menção vai em `mentions`, que gera a notificação, E vira `@[Nome](id)` no texto).
- Cadastro: `cange register create --register-id <id> --set ...` e
  `cange register update --register-id <id> --form-answer-id <entrada> --set ...`.
- Valores inline: `--set "Campo=valor"` (repetível, o primeiro `=` separa) ou `--values-json '{"Campo": valor}'`.
  Com `--payload` junto, o inline vence.
- Chave do campo (todas as escritas, inclusive `--payload`): hash (`name`), id numérico ou TÍTULO do campo
  (sem diferença de maiúscula/acento). Título repetido: vale a etapa atual, depois o formulário inicial; empate é erro
  listando as opções (use o id).
- Valor como na tela: número e moeda em texto ("2500", "2.500,00", "R$ 2.500,00", "2500.5"; "2.500" é ambíguo e dá
  erro), percentual "90%", data "06/10/2026" ou ISO, opção pelo rótulo, checkbox "A, B", interruptor sim/não,
  usuário por id, e-mail ou nome (único na empresa), cadastro por id, lista de ids ou nome da entrada (busca no
  cadastro; 0 ou 2+ resultados = erro com os candidatos).
- `card move`: cada campo é procurado na etapa atual, no destino e no formulário inicial e vai para a chamada certa
  (o back aceita UM formulário por chamada): inicial = `PUT /form/answer` antes; etapa atual = no próprio mover (com os
  campos que o cartão já tem nessa etapa, para nada sumir); destino = `PUT /form/answer` depois. No caso comum é UMA
  chamada. Falha depois de uma escrita = exit `5` com `done` (o que foi gravado).
- `--dry-run` em qualquer escrita imprime o payload RESOLVIDO (chave hash, valor no tipo do campo) e `validation`
  (`{valid}` ou `{valid:false, message}`), sem gravar. Exit `0` válido, `2` inválido.
- `--validate-fields` também cobra os obrigatórios na criação. Ao mover, os obrigatórios da etapa atual são cobrados
  SEMPRE (a flag segue aceita, sem efeito no `card move`).
- Erro de validação vem numa mensagem só, curta, com tudo que falta ou está errado:
  `Falta para a etapa Agendamento: Data da ligação (data), Agendamento (Sim | Não)`. Exit `2`, nada gravado.
  No mover, a mensagem termina com a regra e o comando pronto, por exemplo:
  `cange card move --card-id 55 --to "Agendamento" --set "Horas=<número>" --set "Qualificado=<Sim | Não>"`.
- Mover com `--payload`: o kit lê o cartão e cobra a etapa ATUAL dele (fromStepId diferente da etapa real = erro).
  Gravando o formulário da etapa atual, o kit reenvia o que o cartão já tem nela (rascunho incluído), com o `values`
  por cima, como o `card move`. Payload que grava OUTRO formulário com rascunho só na etapa atual bloqueia (o back
  apaga o rascunho ao sair da etapa): use `card move` ou `--allow-data-loss` (vale também no `card move-step`; aceita
  perder só o rascunho da etapa atual, listado no `warning`, e o do formulário gravado segue reenviado).
- Obrigatório é o que a TELA cobra: regra `required` do campo (`validations`), não a coluna `required`. Switch nunca é
  cobrado; check list sem a regra também não; rich text `<p></p>` é vazio; check list com "exigir todos concluídos"
  (`formula = '1'`) e item sem marcar bloqueia o mover (oculto e com condicional também; item sem descrição não conta).
- Sucesso: uma linha em `summary` (cartão, campos, etapa) e os ids.
- Nunca mova o cartão para a própria etapa para gravar campo: o `PUT /form/answer` cria a resposta da etapa atual
  quando falta. O kit trata sozinho o 409 `STEP_FORM_ANSWER_BUSY` (1 nova tentativa) e o 422 `FIELD_FORM_MISMATCH`
  (refaz com o formulário certo); o 422 `STEP_FORM_NOT_CURRENT` (campo de outra etapa) volta em 1 linha com o
  `cange card move --to "<etapa>"` certo. Cartão excluído: 404 `CARD_DELETED`, mensagem repassada como veio.
- Receitas: `cange recipe criar-card | gravar-campos | mover-card | comentar | mencionar`.

## Sinônimos e ids flexíveis (desde 05/10/2026)

- Busca: `--q` e `--search` são sinônimos em toda listagem com busca (`catalog`, `register entries`, `flow query`,
  `card list`, `my-flows`, `my-registers`; nos dois últimos, `--name` também).
- Ids: `--flow-id`/`--id-flow`/`--flow`, `--register-id`/`--id-register`/`--register` e `--card-id`/`--card`/`--card-ids`
  aceitam o número, o link do Cange (`https://app.cange.me/register/<hash>`, `.../flow/<hash>/card/<id>`,
  `cange://card/<id>`) ou o hash do link (fluxo e cadastro). O kit troca pelo id; o link do cartão também preenche o
  `--flow-id` ausente. Hash sem acesso: erro de uso com o caminho (`cange my-registers` / `cange catalog`).
- **Sem o fluxo, o kit descobre pelo número do cartão** (desde 06/10/2026): comando de cartão (`card read`, `card get`,
  `card move`, `card update-values`, `comment create`, `comment list`, `attachment download`) com `--card-id` numérico,
  sem `--flow-id` e sem fluxo no ambiente do run, pergunta ao back (`GET /card/locate`, mesmo acesso da leitura) e usa
  o fluxo dele. Com fluxo no ambiente, mas `--card-id` diferente do cartão do run, também consulta (se der 404, usa
  o fluxo do ambiente); `--flow-id` explícito sempre vence. A saída traz `resolved: { flow_id, flow_name, via: "card-locate" }`. Não liste fluxos para achar o
  cartão. Se não achar (número errado, sem acesso ou back antigo), o erro pede o link do cartão ou `--flow-id`.
  No `access request` o recurso é um que você NÃO acessa, então link e hash não resolvem: ache o id pelo nome
  (`cange catalog --q <nome>`) e peça com ele.
- `register entries` e `register get` aceitam `--register` (como o `access request`). `card update` aceita
  `--validate-fields` sem efeito (ele não grava `values`; para campos use `card update-values`).
- Comando inexistente responde com a sugestão: `cange search` aponta `register entries --search` e `catalog --q`;
  `register-entries` vira `register entries`. Exit `2` como todo erro de uso.

## Acesso do agente a fluxos e cadastros (desde 02/10/2026, só com token de run)

- `cange catalog [--type flow|register|all] [--q texto] [--limit n]`: NOMES dos fluxos e cadastros que o agente
  pode ver, com `access` "sim"/"não" e o papel (`items` [{id, name, type, access, role}]). No chat e na rotina a
  visão é a de quem conversa (ou do dono da rotina) somada à do agente; numa automação sem conversa, só o que o
  agente já vê. Nunca traz conteúdo. `--full` traz o `raw`; `--raw` devolve a resposta crua.
- `cange access request --flow <id> | --register <id> [--role M] --reason "..."`: cria o PEDIDO de acesso no
  servidor (não dá acesso sozinho e não pausa a execução). A aprovação concede sempre Membro (`--role A` dá erro de
  uso: Administrador só pelo bloco Ferramentas > Cange). Quem pode convidar pessoas para o recurso decide. A
  saída traz `approvalId`, `whoCanApprove` e `message` (a frase pronta para a resposta, ex.: "Pedi acesso ao
  fluxo Compras. Quem pode liberar: Ana, Bruno.").
- Fluxo: não achou no `my-flows` ou tomou 404 de acesso → `cange catalog --q <nome>` → `cange access request`.
  Nunca diga que um fluxo não existe sem olhar o catálogo; nunca grave nomes do catálogo na cabeça.
- Erro 403/404 de "sem acesso ou não encontrado" (exit `4`) num fluxo, cadastro ou cartão que o comando referenciou
  por id (opção, `--payload` ou ambiente do run) traz o campo `hint` no JSON do erro com o pedido pronto, tipo e id
  certos: `Se o recurso existe e você não tem acesso, peça: cange access request --flow 316 --reason "<por que precisa>"`.
  Cartão vira o pedido do fluxo dele (`access request` só pede fluxo ou cadastro). Siga o `hint` com o motivo real; não
  pergunte ao usuário se deve pedir. O back não separa "não existe" de "sem acesso"; se o id foi inventado, confira antes.
- Tarefa seguinte (desde 03/10/2026): quando o acesso (ou a mudança na cabeça, `cange agent head propose`) é um
  MEIO para o que pediram numa conversa, passe `--then "<o que falta fazer>"`. O kit manda `then` no corpo; o
  Cange guarda (uma linha, até 1.000 caracteres) só se o run é de conversa e, aprovado o pedido, retoma a conversa
  sozinho uma vez com essa tarefa. A saída traz `continuation`: `combinada` (com `then`, a tarefa guardada),
  `pedido anterior` (o pedido já estava aberto e o `--then` novo não vale) ou `sem conversa` (nada fica guardado).
  Com `combinada`, diga que segue sozinho depois da aprovação; não peça ao usuário para avisar. Na cabeça, sem
  `--then` aprovar só avisa na conversa.

## Sequência recomendada para mutações com values (modo avançado, `--payload`)

1. `cange my-flows`, `cange my-registers`, `cange my-tasks` e `cange notifications --is-archived N`
2. `cange flow get ...` ou `cange register get ...`
3. `cange fields by-flow ...` ou `cange fields by-register ...`
4. `cange template flow-create ...` ou `cange template register-create ...`
5. mutação com `--validate-fields --dry-run`
6. mutação final sem `--dry-run`

## Sugestões operacionais importantes

- Antes de executar tarefa ou mover card:
  - obter o card completo para identificar a etapa atual (`flow_step_id`) e o formulário dela (`flow_step.form_id`).
  - quando precisar de campos específicos do card, usar `card get --field-ids <id1,id2,...> --summary-only`.
  - obter os fields do flow e filtrar pelo `form_id` da etapa atual para identificar campos obrigatórios (`required = "1"`).
  - usar `card move-step-with-values --discover-required` para listar requireds do `form_id` antes de montar o payload final.
  - preencher todos os obrigatórios da etapa atual no `values` do payload de movimentação (o kit recusa sem eles;
    se o pedido não traz os valores, pergunte ao usuário).
  - o `idForm` do payload deve ser o `form_id` da etapa atual, não o `form_init_id` do fluxo.
  - chamadas sugeridas:
    - `cange --output json my-tasks --flow-id <flowId> --step-id <stepId>`
    - `cange --output json card get --flow-id <flowId> --card-id <cardId> --field-ids <fieldId1,fieldId2> --summary-only`
    - `cange --output json step-form --flow-id <flowId> --step-id <stepId>`
    - `cange --output json fields by-flow --flow-id <flowId>`
    - `cange card move-step-with-values --discover-required --flow-id <flowId> --form-id <formId>`
    - mutação com `card move-step-with-values --validate-fields --dry-run` (se falhar com `UNKNOWN_FIELD_TYPE`, usar só `--dry-run`)
- Ao executar/mover:
  - comentar o que foi feito e por quê.
  - chamadas sugeridas:
    - `cange comment create --payload ./payloads/execution-note.json --dry-run`
    - `cange comment create --payload ./payloads/execution-note.json`
- Ao ler/responder comentário:
  - marcar notificação relacionada como lida/arquivada.
  - chamadas sugeridas:
    - `cange --output json notifications --is-archived N`
    - `cange notification read --payload ./examples/notification-read.example.json --dry-run`
    - `cange notification read --payload ./examples/notification-read.example.json`

## Saída e previsibilidade

- Use `--output json` quando o resultado for consumido por automação.
- **Não precisa de `--silent`**: o stdout já sai limpo (banner do pnpm silenciado no `.npmrc`). Sem `--output`, o modo é json em pipe e pretty em terminal.
- **stdout = só o dado; stderr = logs/avisos/erros.** `... 2>/dev/null | jq .` funciona em qualquer leitura.
- Exit codes por categoria: `0` ok · `2` uso/validação · `3` auth · `4` rede/API · `5` **lote parcial** · `1` inesperado.
- **Exit `5` = a operação em lote saiu INCOMPLETA.** Use só os ids que o resumo devolveu, reprocesse o que está em `failures`/`notAttemptedPayloads` e reporte a tarefa como parcial se não fechar. Nunca deduza id que não foi retornado.

## Criação/leitura em lote (rate limit)

A API limita **por chave**: 10 req/s em leitura, 20 req/s em escrita — e estourar
**bloqueia a chave por ~5 minutos**. Foi o que transformou um lote de 28 cards em
20 sem ninguém perceber (o agente vinculou 8 ids que nunca existiram).

- 2+ cards para criar → `cange card create --payload-dir <dir>` ou `--payloads a.json,b.json`.
  **Nunca** `for f in *.json; do cange card create …; done`.
- 2+ cards para ler → `cange card read --card-ids <a,b,c>`.
- Sempre confira `created`/`failed`/`notAttempted` no retorno antes de montar
  vínculos, contagens ou conclusão.
- O lote **não repete** create que falhou por 5xx/timeout (POST não idempotente,
  sem chave de idempotência no backend): o item vira falha com o aviso de
  **conferir se o card existe** antes de reprocessar. Só 429 é repetido.
- **Rodando dentro do `cange-agent-runner`:** o gate de aprovação deriva o alvo de
  `--payload <arquivo>` e ainda **não** entende `--payload-dir`/`--payloads`. O lote
  é pausado para aprovação normalmente, mas o pedido chega sem o flow derivado e
  rotulado como "Criar **um** card" (mesmo sendo N). Quem aprova precisa ler a
  linha de comando do pedido.

## Discovery antes de adivinhar

- **`pnpm cli manifest --output json`** é a fonte de verdade: todos os comandos, flags (required/tipo), envelope de saída e 1 exemplo por comando — gerado do registry, nunca desatualiza.
- Para um comando: `pnpm cli <comando> --help` já traz o envelope que ele retorna e onde vivem os campos-chave.
- Comando/flag inválido responde com a mensagem + a rota de discovery e exit `2` — leia e corrija, não chute de novo.

## Loop de feedback (quando um agente se perde no kit)

Todo episódio de "agente errou o comando/flag/envelope" deve gerar **duas** saídas:
1. **Correção na ferramenta**: melhorar a mensagem de erro, o `manifest`/`--help` ou o metadado do comando (`annotateCommand`) — a ferramenta deve ensinar o próximo passo.
2. **Registro reutilizável**: anotar o aprendizado onde os agentes leem (memória/playbook), citando o comando.

Sem esse loop, o mesmo buraco reabre a cada evolução do kit.

## Base de conhecimento MCP-style

- Guia principal: `docs/agent-mcp-kb.md`
- Changelog para atualização de playbooks: `docs/agent-changelog.md`
- Playbooks por cenário: `docs/playbooks/`
  - tarefas pendentes
  - notificações
  - resposta por comentários
  - execução + conclusão/movimentação
  - criação de novos cards
