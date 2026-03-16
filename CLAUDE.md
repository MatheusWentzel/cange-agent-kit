# CLAUDE.md - cange-agent-kit

Use este repositório como camada segura para operar o Cange via CLI.

## Fonte de verdade no projeto

1. `docs/agent-mcp-kb.md` (guia principal)
2. `docs/playbooks/README.md` (skills por cenário)
3. `AGENTS.md` (regras operacionais)

## Regras obrigatórias

- Usar somente `pnpm cli ...` para operações do Cange.
- Preferir `--output json` para decisões automatizadas.
- Para JSON puro em pipe, usar `pnpm --silent cli --output json ...`.
- `--payload` sempre deve apontar para arquivo JSON (não usar JSON inline).
- Em payloads de mutação fora de `values`, usar chaves camelCase (`flowId`, `cardId`, `registerId` etc).
- Sempre fazer discovery antes de mutações.
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
- Para mover etapa de card, sempre usar `card move-step-with-values` com `idForm` (`flow_step.form_id`) e `values` (usar `{}` quando não houver campos obrigatórios).
- Para marcar notificação como lida/arquivada, usar `notification read`.

## Fluxos prontos (skills)

- tarefas pendentes: `docs/playbooks/01-pending-tasks.md`
- notificações: `docs/playbooks/02-notifications.md`
- responder notificações: `docs/playbooks/03-reply-notifications.md`
- executar e concluir/mover card: `docs/playbooks/04-execute-and-move-card.md`
- criar novo card: `docs/playbooks/05-create-card.md`
