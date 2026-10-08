# CLAUDE.md - cange-agent-kit

Use este repositório como camada segura para operar o Cange via CLI.

## Fonte de verdade no projeto

1. `docs/agent-mcp-kb.md` (guia principal)
2. `docs/playbooks/README.md` (skills por cenário)
3. `AGENTS.md` (regras operacionais)

## Regras obrigatórias

- Usar somente `pnpm cli ...` para operações do Cange.
- **Antes de adivinhar comando/flag, rodar `pnpm cli manifest --output json`** (fonte de verdade gerada do registry) ou `pnpm cli <comando> --help`.
- `--output json` para decisões automatizadas. **O JSON já sai limpo em pipe sem `--silent`** (banner do pnpm silenciado via `.npmrc`); sem `--output`, o modo é json em pipe e pretty em terminal.
- **stdout = só o dado; stderr = logs/avisos/erros.** Exit codes: 0 ok, 2 uso/validação, 3 auth, 4 rede/API, 5 lote parcial, 6 ferramenta de API falhou (`tool call` com `success:false`), 1 inesperado.
- `--payload` (avançado) sempre aponta para arquivo JSON; valores inline vão em `--set "Campo=valor"` / `--values-json`.
- Em payloads de mutação fora de `values`, usar chaves camelCase (`flowId`, `cardId`, `registerId` etc).
- Sempre fazer discovery antes de mutações.
- **Criar 2+ cards = LOTE em 1 comando**: `pnpm cli card create --payload-dir <dir>` (ou `--payloads a.json,b.json`). Nunca um loop de shell chamando `card create` N vezes — a rajada estoura o rate limit (20 req/s de escrita), a chave é bloqueada por 5 min e os creates seguintes falham. Ler 2+ cards: `card read --card-ids`.
- **Exit 5 = lote PARCIAL** (parte processada, parte não): usar só os ids devolvidos em `cardIds`, reprocessar `failures`/`notAttemptedPayloads` e reportar como parcial se não fechar.
- Para payloads com `values`:
  - chave = `field.name`
  - respeitar `field.type`
  - respeitar `form_id` correto
  - preencher requireds na criação
- Em mutações, executar nesta ordem:
  1. validar contexto
  2. `--validate-fields` (quando disponível)
  3. `--dry-run`
  4. execução real
- Escrita em 1 passo é o padrão (ver `AGENTS.md`, "Escrita em 1 passo"): `card create --flow-id N --set ...`, `card update-values --card-id N --set ...`, `card move --card-id N --to <etapa> --set ...`, `comment create --card-id N --text ... --mention ...`. No mover, a origem é a etapa atual e o kit manda cada campo para o formulário certo (etapa atual vai no próprio mover, como a tela). Com `--payload` (avançado), o `idForm` do mover é o form da etapa ATUAL; ⚠️ **NUNCA** o form de criação (`form_init`): o contrato rejeita (guard), pois isso criaria um `form_answer` duplicado sob o `form_init` que vence o FlowQuery V2 e zera os campos do card no V2/Kanban. Nunca mover para a própria etapa para gravar campo: use `card update-values`.
- **Mover exige os obrigatórios da etapa atual; peça os valores ao usuário se não estiverem no pedido.** O kit cobra
  sempre, em todo caminho de mover (com ou sem `--validate-fields`/`--dry-run`); faltou = exit 2, nada gravado, com o
  comando `card move ... --set` pronto. Igual à tela: não cobra ao voltar etapa em fluxo com "pular obrigatórios ao
  voltar" nem campo oculto no formulário; obrigatório com condicional vazio não bloqueia e volta em `warning`.
  Obrigatório = regra `required` do campo (como a tela; switch nunca), rich text `<p></p>` é vazio e check list
  "exigir todos concluídos" com item sem marcar bloqueia (oculto e com condicional também). O que o cartão tem na etapa vem do rascunho da etapa
  (`GET /form/pre-answer`, a fonte da tela) e o mover reenvia (o back apaga o rascunho do formulário que grava, o do
  destino também); campo vazio com autocompletar recebe o valor que a tela poria (`autocompleted`, pelo mesmo
  `POST /form/answers/by-cards` da tela); origem do autocompletar vazia no cartão = obrigatório cobrado, como na tela.
  Valor gravado que a tela não mostra (usuário bloqueado, leitor ou fora do fluxo; cartão conectado excluído; opção
  apagada ou "none"; anexo que não existe) conta como vazio: obrigatório bloqueia com o motivo, o resto sai do mover
  e vai em `warning`. Documento e telefone com formato que a tela recusa (CPF/CNPJ pelo dígito e pela variation,
  telefone com 10 ou 11 dígitos) bloqueiam o mover e o `--set`, obrigatório ou não.
- Para marcar notificação como lida/arquivada, usar `notification read`.
- Para construir fluxos (fluxo, etapas, campos, relacionamentos), usar `cange flow-build ...` (Flow V2 Build API):
  - bodies são **strict** — não enviar chaves extras.
  - antes de criar campos, descobrir tipos com `flow-build field-types list` / `flow-build field-types get --type <TIPO>`.
  - exige admin do fluxo (`flow_user.type = 'A'`); 404 com `FLOW_NOT_FOUND` indica falta de permissão.

## Fluxos prontos (skills)

- tarefas pendentes: `docs/playbooks/01-pending-tasks.md`
- notificações: `docs/playbooks/02-notifications.md`
- responder notificações: `docs/playbooks/03-reply-notifications.md`
- executar e concluir/mover card: `docs/playbooks/04-execute-and-move-card.md`
- criar novo card: `docs/playbooks/05-create-card.md`
- construir fluxo (Flow V2 Build): `docs/playbooks/06-build-flow.md`
- cards pai-filho ("Meus Fluxos" / `card add-child` + `card relationship`): `docs/playbooks/07-parent-child-cards.md`
