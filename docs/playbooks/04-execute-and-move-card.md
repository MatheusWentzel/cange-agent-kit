# Playbook 04: Executar tarefa na etapa e concluir/mover cartão

## Objetivo

Executar a ação necessária no card e finalizar o ciclo operacional.

## Fluxo recomendado

1. Identificar card alvo em `my-tasks`:

```bash
pnpm cli --output json my-tasks
```

2. Abrir contexto detalhado:

```bash
pnpm cli --output json card get --flow-id <flowId> --card-id <cardId>
```

3. Executar trabalho no card (conforme tarefa):

- atualizar respostas dinâmicas:

```bash
pnpm cli card update-values --payload ./payloads/update-values.json --validate-fields --dry-run
pnpm cli card update-values --payload ./payloads/update-values.json --validate-fields
```

- adicionar comentário de evidência:

```bash
pnpm cli comment create --payload ./payloads/execution-note.json --dry-run
pnpm cli comment create --payload ./payloads/execution-note.json
```

- anexar evidência (opcional):

```bash
pnpm cli attachment upload --file ./evidencias/resultado.pdf
pnpm cli attachment link-card --payload ./payloads/link-attachment.json --dry-run
pnpm cli attachment link-card --payload ./payloads/link-attachment.json
```

4. Concluir cartão:

```json
{
  "flowId": 19263,
  "cardId": 827730,
  "complete": "S"
}
```

```bash
pnpm cli card update --payload ./payloads/card-complete.json --dry-run
pnpm cli card update --payload ./payloads/card-complete.json
```

5. Verificar estado final:

```bash
pnpm cli --output json card get --flow-id <flowId> --card-id <cardId>
pnpm cli --output json my-tasks
```

## Importante sobre “mover cartão”

- O kit não expõe comando dedicado para alterar etapa (`flow_step_id`) diretamente.
- Estratégia suportada: concluir (`complete: "S"`) e depender da regra do fluxo para transição.
- Se o fluxo exigir movimentação manual sem automação, escalonar para ação humana no app.
