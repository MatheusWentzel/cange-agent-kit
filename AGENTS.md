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
- Para mover etapa de card, sempre usar `card move-step-with-values`, mesmo sem obrigatórios.
- Quando não houver campos para preencher, enviar `values: {}`.
- Ao mover etapa, o `idForm` do payload deve ser o `form_id` da etapa atual (`flow_step.form_id`), não o `form_init_id` do fluxo.
- Ao mover etapa, preencher todos os campos com `required = "1"` do `form_id` da etapa atual antes de mover.
- Ao mover etapa, **preservar os campos já preenchidos** (read-before-move): o move grava um form_answer NOVO contendo só o que vier em `values` — campos do `form_id` da etapa não reenviados ficam vazios (perda de dados). Ler o card antes (`card get`) e incluir no `values` os campos já preenchidos, além dos obrigatórios. O kit detecta e avisa campos preenchidos ausentes do `values`; use `--allow-data-loss` para confirmar perda intencional ou `--fail-on-data-loss` para bloquear.
- **Nunca fazer self-move** (`fromStepId === toStepId`) para "criar"/preencher um form_answer: duplica o form_answer e o snapshot vazio mais recente sobrepõe o preenchido. Para apenas atualizar values sem mover, usar `card update-values`. O kit bloqueia self-move por padrão (`--allow-self-move` força).
- Usar `step-form --flow-id <id> --step-id <id>` para descobrir obrigatórios da etapa antes de montar payload.
- Para marcar notificação como lida/arquivada, usar `notification read`.
- Usar `template flow-create`, `template register-create` e `template step-move` antes de mutações quando necessário.
- Usar `--validate-fields` e `--dry-run` antes de mutações quando apropriado.
- Se `--validate-fields` falhar com `UNKNOWN_FIELD_TYPE`, omitir `--validate-fields` e executar apenas com `--dry-run`. Tipos não mapeados na validação local não impedem a mutação na API.
- `--payload` sempre deve receber caminho de arquivo JSON, nunca JSON inline.
- Inputs de mutação fora de `values` devem usar camelCase (`flowId`, `cardId`, `registerId` etc).
- Não inventar IDs.
- Não inventar chaves de `values`.
- Se houver falha de autenticação, revisar `CANGE_ACCESS_TOKEN` ou `CANGE_EMAIL` / `CANGE_APIKEY`.

## Sequência recomendada para mutações com values

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
  - preencher todos os obrigatórios da etapa atual no `values` do payload de movimentação.
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
- Exit codes por categoria: `0` ok · `2` uso/validação · `3` auth · `4` rede/API · `1` inesperado.

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
