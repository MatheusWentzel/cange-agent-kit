# Agent Changelog

Este changelog é focado em quem mantém playbooks/agentes (Codex, Claude Code, etc.).

## 2026-10-07

### Mover: leituras do que a tela resolve no ritmo do teto do back, com prazo (REG-F1)

- Com o ritmo fixo de 2 leituras por segundo (fb822a2), `card move --dry-run` no cartão 921055 (43 anexos no
  formulário da etapa) levava 22,7 s, e só 0,43 s disso era o back. A conferência automática do gate do runner (prazo
  de 15 s) morria sem resposta e negava com "o kit não respondeu no prazo" a cada tentativa: o agente nunca conseguia
  pedir aprovação para esse cartão (o 918594, com 30 anexos, também estourava).
- Agora cada leitura (anexo, lista do campo de usuário, cartão conectado) sai uma por vez e só começa quando menos de 8
  GETs do processo ainda podem cair na mesma janela do back que ela (`apiRateLimiter`, 10 GET/s por chave numa janela
  fixa, a 11ª bloqueia por 5 minutos): os que o mover fez antes também contam, o que está em voo conta sempre e o que
  terminou só sai da conta 1 s depois do fim. O back conta a leitura quando ela chega, e a primeira conexão chega
  depois de sair do kit: contando pelo início, a janela do back do 921055 chegou a 10. O cliente HTTP anota o início e
  o fim de toda tentativa de GET.
- Medido no back local (proxy na frente do 8092): 921055 e 918594 com no máximo 8 GETs em qualquer janela de 1 s, 43
  anexos conferidos em 5 a 7 s, mesmo resultado do fb822a2. A conferência do gate (`kitDryRun`, prazo de 15 s) responde
  em 5,4 s no 921055 e 4,6 s no 918594, com exit conclusivo (antes: 15,0 s, sem resposta).
- A conferência tem prazo de 8 s: a leitura que não começaria a tempo não é feita, o valor gravado vai como está (o kit
  não afirma o que não leu, como na falha de leitura) e o campo sai no `warning` ("Não conferidos no prazo ...:
  Documentos IRPF (13 de 43 anexos)"). Obrigatório não conferido não bloqueia. Assim o mover sempre responde dentro do
  prazo do gate, com qualquer número de anexos.
- `CANGE_SCREEN_REFS_RPS` agora é o máximo de GETs por janela de 1 s (default 8) e `CANGE_SCREEN_REFS_BUDGET_MS` o prazo
  (default 8000); os dois são para teste. O token de run do agente não passa pelo teto de 10 GET/s do back (só a API
  key passa), então o runner pode subir o `CANGE_SCREEN_REFS_RPS` no ambiente do run se quiser o mover mais rápido.

### Catálogo pelo número, link ou hash (bancada F2-F6, t06)

- A t06 falhou 2 vezes (frio 5 min, 3ª repetição; quente, 1ª): depois do "sem acesso" no fluxo 316, o agente procurou
  `cange catalog --q 316`; o back busca só pelo nome, não achou, e o agente perguntou ao usuário em vez de pedir acesso.
- Agora `--q`/`--search` com um inteiro positivo (`316`, `#316`) procura também pelo id, e um link do Cange
  (`.../flow/<hash>`, `.../register/<hash>`, `cange://card/<id>?flow=<id>`) ou um hash solto (hex) procura pelo id do
  fluxo ou cadastro dele. Número também busca pelo nome (um fluxo pode ter o número no nome); link e hash, não.
- O achado pelo id vem primeiro em `items`, com `match: "id"` e, sem acesso, `request` com o pedido pronto
  (`cange access request --flow 316 --reason "<por que precisa>"`, a mesma frase do `hint` do erro sem acesso). A
  nota diz para pedir com o motivo real, sem perguntar ao usuário, e com `--then` quando o acesso é um meio. Com
  acesso: "leia direto". O `--limit` não corta o achado pelo id. `--raw` com número, link ou hash devolve
  `{ byName, byId[] }`; `--full` marca o item com `matchedBy: "id"` e `request`.
- **Sem vazar existência:** o back não busca por id, então o kit lê a lista do catálogo do tipo (sem filtro, até o
  teto de 500 do back, um tipo por vez) e filtra pelo número. É a mesma visibilidade da busca pelo nome (o que o agente
  ou quem conversa vê). Fora dela: "não está no seu catálogo; não peça por esse id e não diga que não existe", igual
  ao `access request`, que recusa sem criar nada (404 `ACCESS_TARGET_NOT_FOUND`, ou 422 `ACCESS_NO_ANCHOR` sem conversa).
  Lista cortada no teto sem o id: a nota manda ao nome ou ao pedido direto.
- Hash sem acesso não vira id (`GET /flow?hash=` e `GET /register?hash=` dão 404 justamente por falta de acesso, como
  no K1 do `access request`): o catálogo não é chamado e a nota manda procurar pelo nome. Link só de cartão: a nota diz
  que o link não traz o fluxo.
- Texto continua uma busca só pelo nome, como antes. 2 ou 3 leituras sequenciais com número (nome + lista por tipo).

### Mover: corte estrito da passagem, referência que a tela não resolve, documento e telefone, autocompletar pelo by-cards (revisão 4 do EXTRA-06)

- **R4-F1, corte estrito:** a resposta confirmada criada pelo movimento que trouxe o cartão para a etapa (o formulário
  público que o tirou da etapa anterior) cai no MESMO segundo da entrada e entrava na disputa com o rascunho
  (`time >= since`), vencendo pela recência da linha (cartão 1114758: o SIM da rodada anterior voltava no formulário
  gravado e apagava o rascunho; 368 cartões ativos em 38 empresas no `cange_local`). Agora o corte é estrito (`>`), e
  no formulário gravado fora da etapa atual (o do destino) o corte é a SAÍDA da última passagem do cartão pela etapa
  dona dele, não a entrada na etapa atual. Sem passagem pela etapa dona, nenhuma confirmada disputa.
- **POP-1 e R4-P1, referência que a tela não resolve:** o kit contava e reenviava o valor cru da fonte da tela, mas o
  componente da tela resolve a referência antes de mostrar e, sem achar, mostra vazio, manda vazio e o obrigatório
  recusa. Agora o kit faz o mesmo com o que reenvia: usuário só da lista do campo (`GET /user/by-flow?form_id` sem o
  leitor; variation "2" pela empresa; cartões 824006, 886823, 311243, 142892), cartão conectado só o que o
  `POST /card/by-cards` devolve (675472), anexo pelo `GET /attachment` (um que não existe e a tela não mostra nenhum),
  combo só valor que existe nas opções ("none" e opção apagada são vazios; a oculta vale; 55161), rádio e caixa de
  marcação só opção visível, check list sem o item de descrição vazia, documento e telefone sem dígito vazios.
  Obrigatório que fica vazio bloqueia com o motivo próprio ("está gravado no cartão, mas a tela mostra o campo vazio
  (usuário 3101 bloqueado, ...)") e a dica pede o `--set`; não obrigatório sai do mover, como a tela, e volta em
  `warning` ("Gravados no cartão que a tela não mostra"). O `dataLossCheck` não os conta como órfãos. O campo de
  usuário vazio só é recusado quando a 1ª regra gravada dele é a `required` (o `matches` do `createYupSchema`); sem
  isso a tela move com ele vazio, e o kit também. O `--set` de usuário (todas as escritas) confere o id contra a mesma
  lista e recusa o bloqueado, o leitor e quem está fora do fluxo privado. Leitura que falha (rede, 5xx) não muda nada.
  Essas leituras saem uma por vez, no ritmo do teto de leitura do back, e os anexos um por um parando no primeiro que
  não existe (o ritmo e o prazo estão na entrada REG-F1, acima).
  **Decisão pendente (Matheus):** o não obrigatório que a tela descarta sai do mover (igual à tela) em vez de ir com
  aviso.
- **R4-P2, documento e telefone:** a tela valida o formato sempre, obrigatório ou não, oculto também, sobre o valor
  com a máscara do componente. O kit faz igual com o que vai no mover: CPF/CNPJ pelo dígito verificador e pelo tipo
  da variation (sem variation = CPF; CNPJ em campo de CPF vira 11 dígitos e não passa; CNPJ alfanumérico aceito) e
  telefone com 10 ou 11 dígitos depois da máscara (a tela corta o dígito que passa de 11, então 12 e 13 dígitos
  gravados passam). Inválido bloqueia com a frase da tela ("CPF inválido", "CNPJ inválido", "CPF ou CNPJ inválido",
  "Telefone inválido") e a dica pede o valor corrigido (cartões 52385, 359355, 357623, 181983, 1116619). O `--set` de
  qualquer escrita confere igual; no telefone o `--set` exige 10 ou 11 dígitos no próprio valor (a tela truncaria
  "+55 21 98765-4321" para outro número; o kit recusa em vez de gravar errado). Voltar etapa com "pular obrigatórios
  ao voltar" segue sem validar (a tela pula o formulário inteiro).
- **POP-2, autocompletar pelo by-cards da tela:** o dinâmico com origem no cartão (`ac_type 0`, origem `> 0`) agora é o
  mesmo `POST /form/answers/by-cards` que a tela faz ao abrir o cartão (lista na ordem dos campos; leitura liberada no
  dry-run forçado), com o mapeamento do `getAutoCompleteRule`: lista de opções pelo `valueString` casado com o rótulo,
  data pelo `sanitizeAutoCompleteDateValue` (dd/mm/aaaa em hora local), o resto copia o valor (ids de anexo
  inclusive). Resolve o vínculo com a origem preenchida (433142: "Estoque Atual" e "Estoque mínimo"), a cópia de anexo
  (1044110), a origem de texto formatado e faz o obrigatório com vínculo vazio bloquear (67034). O estático de anexo
  também vai. Todo autocompletar que o kit não calcula (usuário atual, by-cards que falhou) volta em `warning`,
  obrigatório ou não ("Campos com autocompletar que o kit não calcula"); antes o não obrigatório sumia do mover calado.
  **Decisão pendente (Matheus):** usuário atual (`-2`) segue como aviso; a tela usa quem abre o cartão.

### Mover: passagem atual, linha repetida, vínculo escolhido no mover e check list oculto (revisão 3 do EXTRA-06)

- **R3-F1, valor de passagem anterior:** na disputa rascunho x resposta confirmada mais nova, a confirmada entrava
  inteira se o form_answer dela fosse mais novo que o do rascunho. Só que o rascunho dura várias passagens (no V1 o back
  não o apaga ao sair) e a resposta do formulário público que TIROU o cartão da etapa é mais nova que ele: o campo que a
  pessoa limpou no rascunho voltava com o valor da rodada anterior (cartão 799470: "Você aprova a arte abaixo?" = NÃO e o
  ajuste antigo num mover para "OK POSTAR"; a tela cobra o obrigatório e não move; 61 cartões ativos e 17 empresas no
  `cange_local`). Agora só disputa a LINHA da confirmada escrita desde a entrada do cartão na etapa atual (o `dt_entry`
  mais novo do `GET /card/moviment`, lido só quando há confirmada mais nova que o rascunho). É o caso do
  `card update-values` gravando na resposta mais recente, que segue valendo. Linha anterior à entrada fica fora, e o
  campo segue como a tela: vazio ou com o autocompletar. Sem a entrada (rota ausente ou sem movimento), nenhuma
  confirmada disputa.
- **R3-F2, linha repetida:** o rascunho pode ter duas linhas do mesmo campo no mesmo `index` (corrida do autosave). O
  kit juntava as duas, não remontava o campo de valor único e o mover o deixava vazio, com o obrigatório contado como
  preenchido (cartão 55241: Tamanho da empresa, Canal de contato e Lead qualificado; 50 cartões ativos com campo
  repetido no rascunho; no check list o item ia em dobro). Agora fica a primeira linha, pela chave resposta-campo-index,
  como o `formAnswerToObjectFormInit` da tela (rascunho, última passagem e confirmadas). E obrigatório preenchido que o
  kit não consegue reenviar (valor gravado que não remonta, fórmula, ID automático) bloqueia o mover com o motivo
  próprio, em vez de ir vazio no snapshot novo.
- **R3-F3, `--allow-data-loss`:** a flag apagava em silêncio o rascunho do formulário de DESTINO (desligava o reenvio do
  A2-F2 e o `dataLossCheck`), e a mensagem de bloqueio só falava da etapa atual. Agora a flag só aceita perder a etapa
  atual: com o `idForm` dela, não reenvia o que o cartão tem nela; com outro `idForm`, aceita perder o rascunho da etapa
  atual, e os campos que somem voltam no `warning`. O rascunho do formulário gravado segue reenviado e conferido.
- **R3-F4, vínculo com a origem escolhida no mover:** com o campo de origem (combo de cadastro ou de cartão do mesmo
  formulário) vazio no cartão e mandado no mover, o kit bloqueava o destino do autocompletar de vínculo ("Falta: Centro
  de custo"), mas a tela o preenche no blur (`POST /form/answers/by-register` com o valor escolhido). O kit faz a mesma
  chamada (leitura; liberada no dry-run forçado) e leva o valor (`autocompleted`). Cadastro sem o campo: fica vazio e o
  obrigatório cobra. Consulta que falha: aviso.
- **R3-F5, check list "exigir todos concluídos" oculto ou com condicional:** o kit pulava o oculto e só avisava no com
  condicional ("a tela só exige se o campo aparece"). A tela (FormBuilder) checa todo check list com a regra pelo valor
  do formulário, oculto (montado com display none) e com condicional incluídos (cartão 606564: 3 de 3 itens sem marcar,
  o kit movia). Agora bloqueia sempre. Item sem descrição a tela descarta antes de conferir, e o kit também.

### Mover: autocompletar com a origem vazia cobra o obrigatório, e o rascunho do formulário gravado vai junto (revisão 2 do EXTRA-06)

- **A2-F1, autocompletar com a origem vazia:** o obrigatório vazio com autocompletar de campo de vínculo
  (`ac_child_field_id`) ou com destino lista de opções virava aviso sempre, mesmo com o campo de origem vazio no cartão.
  A tela (`POST /form/answers/by-cards`) não preenche nada nesse caso e o obrigatório cobra: o kit deixava mover o que a
  tela recusa (cartão 233055, "Urgência" com a origem vazia; 424 cartões ativos no `cange_local`). Agora o kit lê o
  campo de origem antes: vazio, o campo fica vazio e bloqueia como na tela. A opção pelo rótulo passou a ser calculada
  como a tela faz (o texto da origem, o `valueString`, casado com o rótulo da opção sem diferenciar maiúscula; linha do
  rascunho sem `valueString`: o rótulo pelo `field_option_id` nas opções do campo de origem); rótulo que não casa deixa o
  campo vazio, e o obrigatório cobra. Segue como aviso só o que o kit não calcula: usuário atual, vínculo com a origem
  preenchida e rótulo de origem que o kit não sabe montar (usuário, data, cadastro). O aviso não afirma mais que a tela
  preenche ("a tela tenta preencher ao abrir o cartão").
- **A2-F2, rascunho do formulário gravado:** o `/card/v2/move-step` apaga o rascunho do formulário que GRAVA, em fluxo com
  ou sem o Flow Query V2. O `--payload` com o form do destino (ou com `idForm` omitido, que cai no destino) e o
  `card move` de etapa sem formulário apagavam o rascunho do destino sem aviso, e o `dataLossCheck` dizia "Nenhum campo
  preenchido seria perdido" (cartões 494824, V1, 3 anexos da automação no rascunho do destino, e 1115530, V2; 8.780
  cartões ativos com rascunho preenchido fora da etapa atual). Agora o kit lê a pré-resposta do formulário gravado (a
  fonte da tela: rascunho ou última passagem) e a reenvia com o `values` por cima, como na etapa atual, sem o
  autocompletar (a tela autocompleta quando o cartão chega na etapa). `kept`/`keptFrom` e o `dataLossCheck` usam essa
  mesma fonte; fórmula e ID automático do rascunho voltam em "Não reenviados". `--allow-data-loss` desliga o reenvio.
- `idForm` omitido no `--payload`: o kit resolve o form do destino (o mesmo do contrato) antes da checagem, e o dry-run
  mostra o `idForm` que vai ser gravado. A nota do detector dizia "form da etapa de origem" (era o destino).

### Erro "sem acesso ou não encontrado" traz o pedido de acesso pronto (`hint`, bancada F2-F6, run 444)

- O agente leu `card list` num fluxo sem acesso, tomou o 404 do back (exit 4), procurou no catálogo pelo nome, não achou
  e perguntou ao usuário em vez de pedir acesso. Agora o erro de API 403/404 cuja frase é de acesso ("sem acesso",
  "não possuí/tem acesso", "acesso negado") ou de "não foi possível encontrar" um fluxo, cadastro ou cartão, num
  recurso que o comando referenciou por id, ganha o campo `hint` no JSON do erro (stderr), depois dos outros:
  `Se o recurso existe e você não tem acesso, peça: cange access request --flow 316 --reason "<por que precisa>"`
  (`--register <id>` para cadastro). Cartão: `peça acesso ao fluxo dele` com o `--flow` do comando; sem o fluxo, o
  comando com `<id do fluxo>` e o caminho do catálogo.
- Ids: opção do comando (já normalizada de link ou hash), `--payload` e, por fim, o ambiente do run (o fluxo do run só
  vale sem cartão ou para o próprio cartão do run). Sem `hint`: frase que nomeia outro recurso (etapa, formulário,
  campo, anexo, vínculo "relacionado" etc.), frase que exige administrador (Flow Build: o pedido só dá Membro) e o
  `CARD_NOT_FOUND`/`CARD_DELETED` do `GET /card` (o fluxo passou na checagem de acesso; o cartão é que não está nele).
  `access request` e `catalog` ficam com as dicas próprias.
- Sem mudança na mensagem do back, no código de saída (4) nem nos outros campos do JSON.

### Mover igual à tela: rascunho da etapa, obrigatório da tela e check list (E2E do lote, EXTRA-06)

- **P0, perda de dado:** o kit decidia o que o cartão tem pelo `GET /card`, que não traz o rascunho da etapa
  (form_answer com `flow_step_id` NULL: autosave da tela, automações, e o `card update-values` quando o rascunho é a
  resposta mais recente). O `POST /card/v2/move-step` apaga o rascunho, e o que estava só nele sumia; e o mover cobrava
  "Falta" de campo que a tela mostra preenchido (cerca de 9,8 mil cartões ativos no `cange_local`). Agora a fonte é a da
  tela, `GET /form/pre-answer?card_id=&id_form=<form da etapa atual>` (rascunho, ou a última passagem confirmada), e
  tudo isso é reenviado no mover. Back sem a rota (404): `GET /card` como antes; outra falha da rota: não move.
- **Rascunho x resposta confirmada mais nova, por campo e pela LINHA** (revisão F1): vence a linha mais nova do campo
  (`form_answer_field.dt_last_update`, no empate o id da linha; campo de várias linhas: a maior entre elas), não a data
  do form_answer. O autosave da tela regrava as linhas do rascunho sem mudar o form_answer, e o kit gravava a confirmada
  antiga por cima do que a pessoa editou depois (cartão 1107439: 18:00 no lugar do 18:30; 39 cartões ativos e 78 campos
  no `cange_local`). A confirmada só vence quando a linha dela é a mais nova, que é o `card update-values` gravando na
  resposta mais recente.
- **Autocompletar da tela** (revisão F2): campo sem linha na pré-resposta recebe o valor do autocompletar dele, como a
  tela, e esse valor conta no obrigatório e vai no mover. O kit calcula o estático (`ac_type = 1`), a data atual, o
  criador do cartão e o valor de outro campo do cartão (a resposta mais recente que o traz; data em ISO). Acabou o falso
  "Falta" em cerca de 10,8 mil cartões (ex.: Prioridade "Média" no cartão 1120391). Saída nova: `autocompleted` (títulos).
  **Pendência:** o kit NÃO calcula o autocompletar de usuário atual (`-2`), de campo de vínculo (`ac_child_field_id`) e
  com destino lista de opções (a tela casa pelo rótulo). Obrigatório vazio com um desses não bloqueia: volta em `warning`
  (como o da condicional); mande o valor com `--set` no mover. Campo com esse autocompletar MANDADO vazio no mover
  (`--set`/`--values-json`/`values` do payload) é campo limpo e bloqueia, como na tela (o autocompletar só roda ao
  abrir o cartão).
- `card move-step` (deprecado) aceita `--allow-data-loss` (revisão F3): a mensagem de bloqueio do rascunho sugeria a
  flag e o comando a recusava.
- `card move-step-with-values --payload` (e `card move-step`) que grava a etapa atual reenvia o que o cartão tem nela,
  com o `values` por cima (antes bloqueava pedindo para o agente incluir). `--allow-data-loss` desliga o reenvio.
  Payload que grava OUTRO formulário com rascunho só na etapa atual: bloqueia (use `card move` ou `--allow-data-loss`),
  só em fluxo com o Flow Query V2 ligado (`use_query_v2 = 'S'`), o único em que o back apaga o rascunho da etapa que o
  cartão deixa; no fluxo sem ele o rascunho fica e o kit não bloqueia.
- Saída do mover: `kept` e `keptFrom` (`rascunho` | `ultima-passagem` | `vazio` | `cartao`). `vazio`: a pré-resposta
  voltou sem nada (sem rascunho com linha e sem última passagem que o back remonte, como a que só tinha anexo) e a
  tela abre o formulário vazio, só com o autocompletar: o kit também, sem olhar o `GET /card`. `cartao` só quando o
  back não tem a rota.
- Rascunho x resposta confirmada mais nova (a régua da linha mais nova, revisão F1) só vale para campo que o mover
  reenvia. Anexo, fórmula e ID automático de uma confirmada mais nova que o rascunho (ex.: o formulário público da
  etapa) não contam como preenchidos: a tela só lê o rascunho e cobra esses campos, e o mover não os levaria.
- **Obrigatório = o que a tela cobra:** regra `required` do campo (`validations` do `GET /field/by-flow`), não a coluna
  `required`. Switch nunca é cobrado (92 de 92 sem regra), check list sem regra também não (32 de 190), e campo com
  regra e coluna 0 passa a ser cobrado. Sem a lista `validations` (back antigo), vale a coluna. Vale no mover, no
  `card create --validate-fields` e no `--validate-fields` do `card move-step`.
- **Rich text vazio:** a régua exata da tela (`isHtmlEmpty` do Texto Formatado): sem tags e com `&nbsp;` como espaço,
  sobrou só espaço = vazio. Vale para `<p></p>`, `<p><br></p>`, `<p>&nbsp;</p>` e também para HTML só com imagem ou
  tabela sem texto (a tela entrega "" ao formulário nesses casos e o obrigatório recusa).
- **Check list "exigir todos concluídos"** (`formula = '1'`): item sem marcar bloqueia o mover, como a tela (oculto e
  com condicional também, desde a revisão 3). O check list e a lista de itens agora são reenviados no mover (antes
  ficavam vazios no snapshot novo).
- **Anexo e botão do rascunho vão no mover** (revalidação do EXTRA-06): a tela manda o anexo como a lista de ids
  (`id_attachment`) e o botão como o JSON do último clique, e o back grava as mesmas linhas na resposta nova. O kit
  deixava os dois em "Não reenviados" e o anexo que a pessoa subiu na etapa, que só existe no rascunho, sumia no mover
  (1.549 cartões ativos no `cange_local` com anexo no rascunho da etapa atual; 358 com botão). Agora vão, da
  pré-resposta (rascunho ou última passagem; a última passagem do back já vem sem anexo). Da confirmada mais nova que o
  rascunho e do `GET /card` (back sem a rota) seguem fora, e o autocompletar de anexo segue pendente. Fórmula e ID
  automático continuam em "Não reenviados" (o kit não calcula).

### `cards count/sum` e `card list` no V1 com fluxo grande seguem o cursor (EXE-K1, EXE-K3)

- Fluxo V1 com `isLargeData = 'S'`: o `GET /card/by-flow` manda 150 por vez com `cursorKey`. O kit parava na 1ª página
  (`cards count` deu 150 num fluxo de 1815; `card list --engine v1` nunca mostrava o 151º). Agora segue `cursorKey` +
  `offset` até o total (teto de 20 mil), páginas de 500. `truncated` só quando a leitura parou antes do fim (teto ou
  cursor vencido). `card list` pede ao back só o que a página precisa e devolve `next` certo; com `--step-id` (o back
  ignora a etapa no fluxo grande) filtra aqui e segue lendo até completar a página.

## 2026-10-06

### Mover exige os obrigatórios da etapa atual, sempre (decisão 1 do Matheus)

**Regra para playbooks e agentes: mover exige os obrigatórios da etapa atual; peça os valores ao usuário se não
estiverem no pedido.** É a regra base da plataforma (a tela só move depois de validar o formulário da etapa atual).

- **Todo caminho de mover cobra, sempre:** `card move`, `card move-step-with-values` (com e sem `--payload`) e
  `card move-step` (deprecado). Antes o kit só cobrava com `--validate-fields` ou `--dry-run`, e o back
  (`POST /card/v2/move-step`) não cobra: agente que movia com obrigatório vazio passa a receber exit `2`, nada gravado.
- **Caminho certo em 1 passo:** o erro diz quais campos faltam e termina com a regra e o comando pronto, com os `--set`
  que faltam (o `card move` grava os campos da etapa atual dentro do próprio mover):
  `cange card move --card-id 55 --to "Agendamento" --set "Horas=<número>" --set "Qualificado=<Sim | Não>"`.
  Com `--set` já no pedido, a dica pede para repeti-los; no `--payload`, lembra que dá para pôr no `values`.
- O que o cartão já tem na etapa atual conta (o `card move` reenvia). No `--payload`, o mover regrava o formulário da
  etapa atual só com o `values`: obrigatório preenchido no cartão e fora do `values` bloqueia (ficaria vazio), com a
  dica de incluir ou usar `card move`. Payload com `idForm` de outro formulário não toca a etapa atual.
- No `--payload`, a etapa cobrada é a REAL do cartão (o kit lê o cartão); `fromStepId` diferente dela é erro.
- Obrigatórios da etapa de DESTINO não são cobrados ao entrar (a tela também não pede): valem quando o cartão sair.
- Exceção, igual à tela: voltar etapa num fluxo com "pular obrigatórios ao voltar" (`skipRequiredOnBackwardMove`).
- `--validate-fields` segue aceito: no `card move` não muda nada; no `--payload`, continua recusando chave
  desconhecida e cobrando também os obrigatórios do `idForm` quando ele é de outro formulário.
- `CANGE_FORCE_DRY_RUN` (conferência do gate do runner): a mesma cobrança aparece em `validation` (exit `2`), sem gravar.
- O caminho por `--payload` agora lê o fluxo e o cartão também em `--dry-run` (antes podia sair sem ler nada).
- Igual à tela (revisão K-D1): campo oculto no formulário (`show_on_form = "S"`) não é cobrado, em nenhum caminho
  (mover e `card create --validate-fields`). A tela zera o obrigatório dele antes de validar; costuma ser preenchido por
  automação. No `cange_local` eram 68 campos em 49 fluxos que travavam o mover.
- Obrigatório com condicional ("Exibir/Esconder campo") vazio não bloqueia: a tela só o exige quando a condicional
  exibe o campo, e o kit ainda não avalia condicionais. Ele volta em `warning` no resultado (e no `--dry-run`); quando
  outro obrigatório bloqueia, a dica cita os com condicional sem pedir `--set` deles. As condicionais vêm do
  `GET /flow` (`flow_steps[].form.fields[].conditionals`), sem chamada a mais.
- `--payload` com `isTestMode: true` (cartão de modo teste) lê o cartão com `isTestMode` e não falha mais com 404.
- No `--payload`, a dica do `card move` manda repetir como `--set` o que já ia no payload (values e `--set`): o
  `card move` só grava o que vier nele.
- A dica do comando troca para hash/id o campo ou a etapa com `$`, crase, `\` ou aspas no nome, e escapa o
  placeholder: o comando segue seguro para colar no Bash.

### Sem o fluxo, o kit descobre pelo número do cartão (F6, runs 357 e 362)

- Comando de cartão com `--card-id` numérico, sem `--flow-id` e sem `RUNNER_FLOW_ID`/`CANGE_CARD_FLOW_ID` no ambiente,
  chama `GET /card/locate?id_card=N` (back: mesmo acesso da leitura, 404 genérico) e usa o fluxo devolvido. A saída
  ganha `resolved: { flow_id, flow_name, via: "card-locate" }`. É leitura: vale também com `CANGE_FORCE_DRY_RUN`.
- Back sem a rota (404) ou cartão sem acesso: o comando dá o erro de sempre, agora com a dica do link do cartão.
- Fluxo no ambiente, mas `--card-id` diferente de `RUNNER_CARD_ID`/`CANGE_CARD_ID`: o kit consulta o locate em vez de
  presumir o fluxo do run; 404 cai no fluxo do ambiente (como antes). `--flow-id` explícito sempre vence.
- `comment create` lê `RUNNER_FLOW_ID` (antes só `CANGE_CARD_FLOW_ID`), como os outros comandos de cartão.
- `--payload` continua com o `flowId` do arquivo (o kit não consulta o cartão nesse modo).

### Listas e contas: página de 20 vale para todo agente; `truncated` também no V1 (3ª revisão da F2c)

- **`card list` no enxuto devolve 20 cartões por página para QUALQUER agente** (antes da F2c vinham todos). Playbook que
  lia a lista inteira de uma vez precisa seguir o `next` (ou usar `--full`). Agora o V1 também diz que há mais:
  `truncated: true` junto do `next`, igual ao V2. Página do V1 traz `next` com `--engine v1` (o cursor dela é número).
- **`--limit` acima de 500** (ex.: 700) devolve `next` com o cursor que continua de onde parou (antes saía
  `truncated` sem cursor).
- **Cursor do V2 não cai mais no V1:** com `--cursor`, falha do V2 vira erro (antes recomeçava do zero e o agente relia
  em laço). Cursor que não é número no V1 é erro de uso (exit 2).
- **`cards count/sum`:** só caem no `/card/by-flow` em falha do motor (rede, 5xx); 401/403/429/4xx propagam. Fluxo
  grande no V1 sai com `truncated: true`. Valor lido do banco com 3 casas (`1.500`, `12,345`) entra na soma no formato
  do back (1,5 e 12,345), não sai mais como "ambíguo".

### Leitura menor (card #1367459, C4): `cards count/sum`, `card read --fields`, listas paginadas, `map` resumido, TOON

- **Novos:** `cange cards count --flow-id N [--by etapa|campo:"<título>"] [--where "<campo>=<valor>"]` e
  `cange cards sum --flow-id N --field "<título>" [--by ...] [--where ...]` → `{total, groups}` (só ativos, com o acesso
  do token). Substituem listar + python/jq. Também como `card count` / `card sum`; `cards list` = `card list`.
- **`card read --fields "<títulos, ids ou hashes>"`:** só esses campos, inteiros. Sem `--fields`, valor acima de 600
  caracteres sai cortado com a dica (antes: 2.000).
- **Listas (enxuto):** `card list`, `register entries` e `my-flows` em páginas de 20 com total e `next` (comando pronto
  com `--cursor`). `register entries` sem `raw`. `--full` igual a antes.
- **`map` (enxuto):** campos agrupados em `startFields` e `steps[].fields`, sem `formId` por campo, `required` só quando
  obrigatório, opções em linha até 8 (`optionsCount` acima). Playbook que lia `flows[].fields[].formId` passa a ler os
  grupos (ou usa `map --full`).
- **TOON experimental:** `--format toon` / `CANGE_OUTPUT_FORMAT=toon` nas listas. Desligado por padrão.
- Medido nos fixtures grandes do teste (`test/leitura-enxuta-c4.test.ts`): `card read` 13.742 → 6.671 caracteres;
  `map` 7.638 → 6.422 (já com as opções curtas que antes não vinham).

## 2026-09-15

### `register create` volta a funcionar (payload agora leva `registerId`)

**O que acontecia:** `cange register create` devolvia **404 em `POST /form/new-answer`**
("Parâmetros inválidos, não foi possível encontrar a referência do formulário!") para
**qualquer** cadastro, com qualquer chave de API. O contrato montava o body com o id do
cadastro aninhado em `registerContext`, e o backend não lê essa chave: a rota decide por
`register_id`/`flow_id` no nível **raiz** do body e, sem nenhum dos dois, devolve 404 antes
de olhar o `id_form`. Por isso o erro era idêntico para um `id_form` inexistente e para o
form de um fluxo onde o bot escreve todo dia — parecia falta de permissão no cadastro e não
era. O `card create` sempre esteve correto (manda `flow_id` achatado); só a criação de
registro divergia. Pior: o `template register-create` gerava um `payloadSkeleton` **sem** o
id do cadastro, então seguir o template levava direto ao erro.

**O que mudou no kit:**

- `createRegister` manda **`register_id` achatado** na raiz do body.
- `createRegisterPayloadSchema` troca `registerContext` (opcional, ignorado) por
  **`registerId` obrigatório** — payload sem o id do cadastro falha na validação local,
  com mensagem clara, em vez de virar 404 da API.
- `template register-create` passa a incluir `registerId` no `payloadSkeleton`: o skeleton
  é copiável sem retoque.
- `register create` com payload no formato antigo (`registerContext`) morre com instrução de
  migração, não com erro genérico de schema.
- Testes de regressão em `test/register-create.test.ts` + asserção do `createRegister` no
  `test/contracts-mapping.test.ts` (a criação de registro era o único contrato de mutação
  sem cobertura do shape do body — foi assim que o bug passou).

**Migração:** no payload de `register create`, troque

```json
{ "registerContext": { "registerId": 175 } }
```

por

```json
{ "registerId": 175 }
```

no nível raiz. O `--register-id` da CLI continua servindo só para a validação local de fields.

**Nota que vale documentar:** `register update` exige `registerId` **junto** de
`formAnswerId` — só o `formAnswerId` cai no mesmo 404, porque `PUT /form/answer` despacha
pela mesma regra.

## 2026-09-09

### Criação em lote + throttle de rate limit (corrige perda silenciosa de dados)

**O que aconteceu:** o agente Comprador criou 28 cards numa rajada de shell
(`for f in *.json; do cange card create …`), estourou o teto de escrita da API
(20 req/s), a chave foi bloqueada por 5 minutos e 8 creates falharam. Como cada
invocação era independente e o retorno não era conferido, o agente vinculou os 28
ids que **esperava** — 8 nunca existiram — e fechou a tarefa como sucesso
(runs 34/35, company 6728; perda de ~29%, reproduzida 2 de 2 vezes).

**O que mudou no kit:**

- `card create` ganhou modo **LOTE**: `--payload-dir <dir>` ou `--payloads <a.json,b.json>`,
  com `--rps` (default 8/s) e `--max-retries` (default 3).
  - valida TODOS os payloads antes de mutar (payload inválido ⇒ nada é criado, exit 2);
  - throttle abaixo do teto + backoff/retry **só em 429** (5xx/timeout não são
    repetidos: `POST /form/new-answer` não é idempotente e o backend não tem chave de
    idempotência — repetir criaria card duplicado; o item vira falha com o aviso de
    conferir se o card existe antes de reprocessar);
  - **para o lote** ao detectar bloqueio por rate limit (429) — enquanto o bloqueio
    dura (~5 min) toda tentativa falha — e também no 403 do gate de agente
    (`APPROVAL_*`/`PERMISSION_REQUIRED`), que é one-shot por requisição;
  - resumo explícito: `created` / `failed` / `notAttempted` + `cardIds` reais + `warning`
    (200 sem `cardId` conta como FALHA, nunca como criado).
- **Exit code 5 = lote PARCIAL** (parte processada, parte não). Antes, um lote
  incompleto era indistinguível de sucesso. Quando **nada** passa, sai a categoria do
  erro (4/3/2/1), não 5.
- `card read --card-ids` passou a respeitar o teto de GET (10 req/s) — a
  concorrência de 5 sozinha podia disparar ~80 req/s — e devolve
  `{ count, ok, errors, notAttempted?, aborted?, cards }`: exit 5 quando parte falha,
  categoria do erro quando nada é lido, e no 429 o lote PARA (o resto volta como
  `notAttempted` em vez de queimar requisição contra chave bloqueada).
- Erros de API agora carregam `retryAfterSeconds`; o retry interno do cliente
  usa backoff maior em 429 e desiste (em vez de dormir) quando a espera passa de 5s.

**Para playbooks/agentes:** 2+ cards ⇒ sempre lote; conferir `created`/`failed`
antes de montar vínculos ou concluir; nunca deduzir id que não foi devolvido.

## 2026-05-12

### Novos comandos: Flow V2 Build API (`/flow/v2/build`)

Agentes agora podem **construir fluxos completos** (fluxo, etapas, campos, relacionamentos) via CLI. Todos os comandos sob `cange flow-build ...`. Playbook: `docs/playbooks/06-build-flow.md`.

Bodies são **strict** (Zod): qualquer chave extra → `VALIDATION_FAILED`. Rotas com `:id_flow` exigem que o token seja administrador do fluxo (`flow_user.type = 'A'`); 404 com `FLOW_NOT_FOUND` indica falta de permissão.

Read-only:

- `flow-build ping` — health do router.
- `flow-build field-types list` — catálogo de tipos de campo aceitos.
- `flow-build field-types get --type <TIPO>` — descritor (`properties[]`, `valueType`, `enumValues`, etc.).
- `flow-build step-relationship list --id-flow <id>` — todas as etapas com `relationship_steps` e `conditionals`.
- `flow-build step-relationship from --id-flow <id> --id-step <parent>` — vista a partir da etapa pai.

Mutações (todas com `--dry-run` para validação offline):

- `flow-build flow create --payload <path>`
- `flow-build flow update --id-flow <id> --payload <path>`
- `flow-build step create --id-flow <id> --payload <path>`
- `flow-build step update --id-flow <id> --id-step <id> --payload <path>`
- `flow-build step reorder --id-flow <id> --payload <path>` (`{ id_step, upDown: 'up' | 'down' }`)
- `flow-build field create --id-flow <id> (--id-step <id> | --form-id <id>) --payload <path>`
- `flow-build field update --id-flow <id> [--id-step <id> | --form-id <id>] --id-field <id> --payload <path>`
- `flow-build step-relationship set --id-flow <id> --payload <path>` (`{ flow_step_id, step_available_id, isActive: '0'|'1' }`)

Regras especiais para campos:

- Tipos sem resposta (`BUTTON_FIELD`, `TITLE_FIELD`, `DESCRIPTION_FIELD`, `DIVIDER_FIELD`): `required` deve ser `'0'` (não `'N'`); sem validações `type: "required"`.
- `FORMULA_FIELD`: `formula` não pode conter `[` nem `]`; placeholders usam `{nome_do_campo}`.
- `COMBO_BOX_FIELD`, `RADIO_BOX_FIELD`, `CHECK_BOX_FIELD`: `options[]` obrigatório e não vazio.
- `type` é imutável após criação (não enviar em `field update`).
- Tipos rejeitados pelo catálogo da API: `PASSWORD_FIELD`, `COMBO_BOX_REGISTER_FIELD`, `COMBO_BOX_FLOW_FIELD`.

Exemplos em `examples/flow-build-*.example.json`.

## 2026-05-07

### Novos comandos

- `card add-label` (mutação):
  - `cange card add-label --payload <path-to-json> [--dry-run]`
  - vincula uma etiqueta (flow_tag) a um card via `POST /flow-tag/card`
  - payload: `flowId`, `cardId`, `flowTagId` (todos `number`, camelCase como demais mutações)
  - resposta `raw` traz `card_id`, `flow_tag_id` e `id_card_flow_tag` (id da relação criada)

### Mudanças de comportamento

- `--dry-run` agora pula `ensureAuth` em **todos** os comandos de mutação. Permite validar payload offline (sem `CANGE_ACCESS_TOKEN`/`CANGE_EMAIL`+`CANGE_APIKEY`) — útil em CI e geração de payload em pipeline.
- `CangeError.toJSON()` omite campos `undefined` (`status`, `endpoint`, `method`, `code`, `details`). Saída fica enxuta — `name` e `message` em destaque, sem `details: undefined` poluindo o output.

## 2026-05-02

### Novos comandos

- `comment list` (read-only):
  - `cange comment list --flow-id <id> --card-id <id> [--summary-only]`
  - lê comentários de um card via `GET /card-comment/by-card`
  - retorna `raw`, `summaries[]` (id, cardId, userId, userName, description, dtCreated, dtCreatedFormatted, fixed, attachmentsCount) e `total`
  - útil em playbooks para checar se uma dúvida já foi respondida antes de bloquear

- `time-tracking create` (mutação):
  - `cange time-tracking create --payload <path-to-json> [--dry-run]`
  - cria registro de time tracking via `POST /time-tracking`
  - **obrigatório** antes de mover cartões de etapas com `flow_step.isRequiredTrack="1"` (ex: etapa Em execução do `[CNG] Roadmap`, step 486)
  - payload: `flowId`, `cardId`, `flowStepId`, `source` (string, ex: `"manual"`), `dtStart`/`dtEnd` (ISO 8601), `duration` (em **segundos**), `billable` (`"S"`/`"N"`), `title`/`description` opcionais
  - sem o track, `card move-step-with-values` falha com `404 — Nesta etapa é obrigatório rastreamento de tempo`

## 2026-03-17

### Novos comandos e flags

- `my-tasks` agora suporta filtros nativos:
  - `--flow-id <id>`
  - `--step-id <id>`
- Novo comando `step-form`:
  - `cange step-form --flow-id <id> --step-id <id>`
  - retorna contexto da etapa + required/optional com tipos e opções
- `card get` ganhou:
  - `--field-ids <id1,id2,...>` para projeção de fields
  - `--summary-only` para retornar só `summary`
- `card move-step-with-values` ganhou:
  - `--discover-required` para pré-descoberta de obrigatórios por `flowId + formId`

### Melhorias de summary

- `card get` passa a expor:
  - `summary.fieldValues` (map flat por `field_id`)
  - `summary.fields` (alias de compatibilidade)
- Quando `--field-ids` é usado, ids não encontrados retornam `null` no mapa.
- `summaries` de card/task agora expõem aliases em snake_case:
  - `id_card`
  - `flow_id`
  - `step_id`

### Melhorias de validação

- Validação de `RADIO_BOX_FIELD` e `COMBO_BOX_FIELD` agora verifica valores reais de `options` (não só tipo).
- Novos erros de validação:
  - `INVALID_OPTION` com lista de opções válidas.
- Erros de validação passam a incluir `fieldTitle` quando disponível.
- Mensagens de required agora priorizam formato humano:
  - `"Título do Campo" (field_name_hash)`

## Como atualizar playbooks

1. Trocar pós-processamento em Python de `card get` por:
   - `card get --field-ids ... --summary-only`
2. Trocar filtro local de `my-tasks` por:
   - `my-tasks --flow-id ... --step-id ...`
3. Antes de mover etapa:
   - usar `step-form` ou `card move-step-with-values --discover-required`
4. Em validação de seleção:
   - tratar `INVALID_OPTION` como erro de payload e ajustar para os valores reais das opções.
