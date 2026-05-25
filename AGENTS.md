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
- Para construir fluxos (criar/alterar fluxo, etapas, campos, relacionamentos), usar **somente** `cange flow-build ...` (Flow V2 Build API, prefixo `/flow/v2/build`).
- Bodies da Flow V2 Build são **strict**: chaves extras causam `VALIDATION_FAILED` — envie apenas o que o schema aceita.
- Para qualquer rota com `:id_flow` em `flow-build`, o token precisa ser administrador (`flow_user.type = 'A'`). 404 com `FLOW_NOT_FOUND` indica falta de permissão ou ID inexistente — não inferir dados.
- Antes de criar campos via `flow-build field create`, descobrir o catálogo com `flow-build field-types list` / `flow-build field-types get --type <TIPO>`.
- Para mover etapa de card, sempre usar `card move-step-with-values`, mesmo sem obrigatórios.
- Quando não houver campos para preencher, enviar `values: {}`.
- Ao mover etapa, o `idForm` do payload deve ser o `form_id` da etapa atual (`flow_step.form_id`), não o `form_init_id` do fluxo.
- Ao mover etapa, preencher todos os campos com `required = "1"` do `form_id` da etapa atual antes de mover.
- Para marcar notificação como lida/arquivada, usar `notification read`.
- Usar `template flow-create` e `template register-create` antes de mutações quando necessário.
- Usar `--validate-fields` e `--dry-run` antes de mutações quando apropriado.
- Se `--validate-fields` falhar com `UNKNOWN_FIELD_TYPE`, omitir `--validate-fields` e executar apenas com `--dry-run`. Tipos não mapeados na validação local não impedem a mutação na API.
- `--payload` sempre deve receber caminho de arquivo JSON, nunca JSON inline.
- Inputs de mutação fora de `values` devem usar camelCase (`flowId`, `cardId`, `registerId` etc).
- Não inventar IDs.
- Não inventar chaves de `values`.
- Se houver falha de autenticação, revisar `CANGE_ACCESS_TOKEN` ou `CANGE_EMAIL` / `CANGE_APIKEY`.

## Setup de dependências (pnpm)

- Rodar `pnpm install` como primeira tentativa.
- Se ocorrer `ERR_PNPM_IGNORED_BUILDS`:
  - rodar `pnpm approve-builds`
  - aprovar apenas `esbuild`
  - rodar `pnpm install` novamente
- Nunca apagar `pnpm-lock.yaml` para "corrigir" instalação.
- Não aprovar build scripts de dependências não revisadas.

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
  - obter os fields do flow e filtrar pelo `form_id` da etapa atual para identificar campos obrigatórios (`required = "1"`).
  - preencher todos os obrigatórios da etapa atual no `values` do payload de movimentação.
  - o `idForm` do payload deve ser o `form_id` da etapa atual, não o `form_init_id` do fluxo.
  - chamadas sugeridas:
    - `cange --output json my-tasks`
    - `cange --output json card get --flow-id <flowId> --card-id <cardId>`
    - `cange --output json fields by-flow --flow-id <flowId>`
    - mutação com `--validate-fields --dry-run` (se falhar com `UNKNOWN_FIELD_TYPE`, usar só `--dry-run`)
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
  - construção de fluxo do zero (Flow V2 Build)
