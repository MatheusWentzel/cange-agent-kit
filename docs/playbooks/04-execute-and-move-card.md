# Playbook 04: Executar tarefa na etapa e concluir/mover cartão

## Objetivo

Executar a ação necessária no card e finalizar o ciclo operacional.

Convenção importante:

- `--payload` é caminho para arquivo JSON.
- No `card update`, usar chaves camelCase como `flowId`, `cardId`, `complete`.
- Para mover etapa, o caminho padrão é `card move --card-id <id> --to "<etapa>" [--set "Campo=valor"]` (1 passo;
  `card move-step-with-values --payload` segue como opção avançada, `values` pode ser `{}`).
- **Mover exige os obrigatórios da etapa atual; peça os valores ao usuário se não estiverem no pedido.** É regra base
  da plataforma (decisão de 06/10/2026, igual à tela): o kit cobra em todo caminho de mover, sempre, e devolve o
  comando pronto com os `--set` que faltam. Exceção única: voltar etapa em fluxo com "pular obrigatórios ao voltar".

## Fluxo recomendado

1. Identificar card alvo em `my-tasks`:

```bash
pnpm cli --output json my-tasks
```

2. Abrir contexto detalhado:

```bash
pnpm cli --output json card get --flow-id <flowId> --card-id <cardId>
pnpm cli --output json card get --flow-id <flowId> --card-id <cardId> --field-ids <fieldId1,fieldId2> --summary-only
```

3. Verificar fields e obrigatórios antes de executar/mover:

```bash
pnpm cli --output json fields by-flow --flow-id <flowId>
pnpm cli template step-move --flow-id <flowId> --from-step-id <fromStepId> --to-step-id <toStepId>
pnpm cli card move-step-with-values --discover-required --flow-id <flowId> --form-id <idForm>
```

Sugestão:

- para movimentação com `values`, usar `idForm = flow_step.form_id` da etapa atual
- não usar `flow.form_init_id` em movimentação (ele é de criação de card)
- garantir preenchimento de requireds (`required = 1`) desse `idForm` (o kit recusa o mover sem eles, com ou sem
  `--validate-fields`; no `--payload`, inclua também os que o cartão já tem, porque o mover regrava o formulário)
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
  "idForm": 102905,
  "values": {},
  "complete": "S",
  "isFromCurrentStep": true,
  "isTestMode": false
}
```

```bash
pnpm cli card move-step-with-values --payload ./payloads/move-card-step-with-values.json --validate-fields --dry-run
pnpm cli card move-step-with-values --payload ./payloads/move-card-step-with-values.json --validate-fields
```

Em 1 passo, sem arquivo (grava os obrigatórios da etapa atual e move na mesma execução):

```bash
pnpm cli card move --card-id <cardId> --to "<etapa de destino>" --set "Campo obrigatório=valor" --dry-run
pnpm cli card move --card-id <cardId> --to "<etapa de destino>" --set "Campo obrigatório=valor"
```

Faltou obrigatório da etapa atual: exit `2`, nada gravado, e a mensagem termina com o comando pronto, por exemplo:

```text
Nada foi gravado.
Falta para a etapa Triagem (atual): Horas (número), Qualificado (Sim | Não)
Mover exige os obrigatórios da etapa atual (regra da plataforma, igual à tela). Se os valores não estão no pedido, pergunte ao usuário (não invente). Com eles, grave e mova no mesmo passo:
cange card move --card-id 55 --to "Agendamento" --set "Horas=<número>" --set "Qualificado=<Sim | Não>"
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
- Os obrigatórios da etapa atual são exigidos sempre (regra da plataforma). Se o pedido não traz os valores, pergunte
  ao usuário e não mova; nunca invente valor para passar. Os obrigatórios da etapa de destino não são cobrados ao
  entrar (valem quando o cartão sair de lá).
- `flow.form_init_id` deve ser usado em `card create`, não em movimentação de etapa.
- Mesmo sem campos obrigatórios, enviar `values: {}` e manter `idForm`.
- Quando a regra do fluxo exigir ações extras, escalonar para ação humana no app.
