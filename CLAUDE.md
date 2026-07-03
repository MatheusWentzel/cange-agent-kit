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
- **stdout = só o dado; stderr = logs/avisos/erros.** Exit codes: 0 ok, 2 uso/validação, 3 auth, 4 rede/API, 1 inesperado.
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
