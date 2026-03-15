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
- Para mover etapa de card, usar `card move-step` ou `card move-step-with-values`.
- Para marcar notificação como lida/arquivada, usar `notification read`.
- Usar `template flow-create` e `template register-create` antes de mutações quando necessário.
- Usar `--validate-fields` e `--dry-run` antes de mutações quando apropriado.
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
  - validar se existem requireds no formulário alvo e preencher todos (`required = "1"`).
  - chamadas sugeridas:
    - `cange --output json my-tasks`
    - `cange --output json card get --flow-id <flowId> --card-id <cardId>`
    - `cange --output json fields by-flow --flow-id <flowId>`
    - mutação com `--validate-fields --dry-run`
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
- Use `--output pretty` para uso humano local.
- Em falhas, tratar saída não-zero como erro operacional.

## Base de conhecimento MCP-style

- Guia principal: `docs/agent-mcp-kb.md`
- Playbooks por cenário: `docs/playbooks/`
  - tarefas pendentes
  - notificações
  - resposta por comentários
  - execução + conclusão/movimentação
  - criação de novos cards
