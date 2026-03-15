# Uso por agentes

## Fluxo seguro obrigatório para mutações com `values`

1. Descobrir contexto (`my-flows`, `my-registers`, `my-tasks`, `notifications`).
2. Obter entidade alvo (`flow get` / `register get`).
3. Obter fields (`fields by-flow` / `fields by-register`).
4. Filtrar fields do formulário correto:
   - card create: `field.form_id === flow.form_init_id`
   - register create/update: `field.form_id === register.form_id`
5. Montar payload usando `field.name` como chave.
6. Validar tipos e obrigatórios.
7. Rodar `--dry-run`.
8. Executar mutação.

## Comandos recomendados antes de mutar

- `cange template flow-create --flow-id <id>`
- `cange template register-create --register-id <id>`
- `cange card create --payload ... --validate-fields --dry-run`
- `cange register create --payload ... --validate-fields --dry-run`

## Regras de ouro

- Nunca inventar chaves dentro de `values`.
- Nunca enviar campo de outro `form_id`.
- Sempre preencher obrigatórios (`required = "1"`) na criação.
- Não usar curl direto quando houver comando da CLI.

## Playbooks operacionais

- [01 - Consultar tarefas pendentes](./playbooks/01-pending-tasks.md)
- [02 - Consultar notificações](./playbooks/02-notifications.md)
- [03 - Responder notificações via comentários](./playbooks/03-reply-notifications.md)
- [04 - Executar tarefa e concluir/mover cartão](./playbooks/04-execute-and-move-card.md)
- [05 - Criar novos cartões](./playbooks/05-create-card.md)

## Guia de ferramentas estilo MCP

- [Agent KB: CLI como MCP](./agent-mcp-kb.md)
