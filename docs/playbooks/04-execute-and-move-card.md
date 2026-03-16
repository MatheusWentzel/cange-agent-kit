# Playbook 04: Executar tarefa na etapa e concluir/mover cartão

## Objetivo

Executar a ação necessária no card e finalizar o ciclo operacional.

Convenção importante:

- `--payload` é caminho para arquivo JSON.
- No `card update`, usar chaves camelCase como `flowId`, `cardId`, `complete`.
- Para mover etapa com payload dedicado, usar `card move-step` ou `card move-step-with-values`.

## Fluxo recomendado

1. Identificar card alvo em `my-tasks`:

```bash
pnpm cli --output json my-tasks
```

2. Abrir contexto detalhado:

```bash
pnpm cli --output json card get --flow-id <flowId> --card-id <cardId>
```

3. Verificar fields e obrigatórios antes de executar/mover:

```bash
pnpm cli --output json fields by-flow --flow-id <flowId>
```

Sugestão:

- para movimentação com `values`, usar `idForm = flow_step.form_id` da etapa atual
- não usar `flow.form_init_id` em movimentação (ele é de criação de card)
- garantir preenchimento de requireds (`required = 1`) desse `idForm`
- usar sempre `--validate-fields --dry-run` antes da mutação real
- se `--validate-fields` falhar com `UNKNOWN_FIELD_TYPE`, repetir apenas com `--dry-run`

4. Executar trabalho no card (conforme tarefa):

- atualizar respostas dinâmicas:

```bash
pnpm cli card update-values --payload ./payloads/update-values.json --validate-fields --dry-run
pnpm cli card update-values --payload ./payloads/update-values.json --validate-fields
```

- anexar evidência (opcional):

```bash
pnpm cli attachment upload --file ./evidencias/resultado.pdf
pnpm cli attachment link-card --payload ./payloads/link-attachment.json --dry-run
pnpm cli attachment link-card --payload ./payloads/link-attachment.json
```

5. Mover cartão de etapa:

```json
{
  "flowId": 14531,
  "cardId": 479486,
  "fromStepId": 81690,
  "toStepId": 81691,
  "complete": "S",
  "isFromCurrentStep": true,
  "isTestMode": false
}
```

```bash
pnpm cli card move-step --payload ./payloads/move-card-step.json --dry-run
pnpm cli card move-step --payload ./payloads/move-card-step.json
```

Se a movimentação exigir respostas no payload (recomendado validar):

```bash
pnpm cli card move-step-with-values --payload ./payloads/move-card-step-with-values.json --validate-fields --dry-run
pnpm cli card move-step-with-values --payload ./payloads/move-card-step-with-values.json --validate-fields
```

6. Publicar comentário de evidência (o que foi feito e por quê):

```bash
pnpm cli comment create --payload ./payloads/execution-note.json --dry-run
pnpm cli comment create --payload ./payloads/execution-note.json
```

7. Verificar estado final:

```bash
pnpm cli --output json card get --flow-id <flowId> --card-id <cardId>
pnpm cli --output json my-tasks
```

## Importante sobre “mover cartão”

- Use sempre `fromStepId` e `toStepId` válidos para o flow.
- Se houver `values`, usar `idForm = flow_step.form_id` da etapa atual e preferir `--validate-fields`.
- `flow.form_init_id` deve ser usado em `card create`, não em movimentação de etapa.
- Quando a regra do fluxo exigir ações extras, escalonar para ação humana no app.
