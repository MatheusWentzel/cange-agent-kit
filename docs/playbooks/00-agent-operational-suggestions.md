# Playbook 00: Sugestões operacionais para agentes

## Objetivo

Padronizar decisões de agente em tarefas e notificações para reduzir erro operacional.

---

## 1) Protocolo obrigatório para concluir etapa e mover cartão

Mover um cartão de etapa é uma operação com duas responsabilidades na mesma transação:

1. preencher os campos obrigatórios do formulário da etapa atual (`flow_step.form_id`)
2. registrar a movimentação para a etapa destino (`toStepId`)

### Atenção: `form_init_id` não é `flow_step.form_id`

- `flow.form_init_id`: formulário de criação do card (usar em `card create`)
- `flow_step.form_id`: formulário da etapa atual (usar em `card move-step-with-values`)

Confundir os dois pode causar envio de campos errados ou falha por obrigatórios não preenchidos.

### Sequência recomendada

1. `card get` para identificar etapa atual (`flow_step_id`) e seu formulário (`flow_step.form_id`)
2. `fields by-flow` para filtrar os fields do `form_id` da etapa atual
3. montar payload:
   - `flowId`, `cardId`
   - `fromStepId` = etapa atual
   - `toStepId` = etapa destino
   - `idForm` = `flow_step.form_id` da etapa atual
   - `values` com todos os `required = "1"` preenchidos
4. executar `--dry-run` (e `--validate-fields` quando disponível)
5. executar mutação real

### Comando de movimentação

- Sempre usar `card move-step-with-values`.
- Mesmo sem obrigatórios, enviar `values: {}`.
- O comando `card move-step` é apenas alias deprecated para compatibilidade.

### Chamadas sugeridas

```bash
pnpm cli --output json card get --flow-id <flowId> --card-id <cardId>
pnpm cli --output json fields by-flow --flow-id <flowId>
pnpm cli card move-step-with-values --payload ./payloads/move-step.json --validate-fields --dry-run
pnpm cli card move-step-with-values --payload ./payloads/move-step.json
```

---

## 2) Fallback quando `--validate-fields` falhar com `UNKNOWN_FIELD_TYPE`

O `--validate-fields` depende de mapeamento local de tipos. Se a API retornar um tipo ainda não mapeado localmente, pode ocorrer `UNKNOWN_FIELD_TYPE`.

Regra prática:

1. tentar com `--validate-fields --dry-run`
2. se falhar com `UNKNOWN_FIELD_TYPE`, repetir sem `--validate-fields`, mantendo `--dry-run`
3. se o `dry-run` estiver coerente, executar mutação real

`UNKNOWN_FIELD_TYPE` pode ser limitação da validação local e não necessariamente erro do payload para a API.

---

## 3) Ao executar tarefa ou mover cartão, comentar o que foi feito e por quê

Após qualquer execução/movimentação, registrar comentário com:

- ação executada
- motivo/contexto
- resultado esperado

Chamadas sugeridas:

```bash
pnpm cli comment create --payload ./payloads/execution-note.json --dry-run
pnpm cli comment create --payload ./payloads/execution-note.json
```

Exemplo de comentário:

`Preenchi os campos obrigatórios da etapa atual e movi para Revisão para liberar aprovação financeira.`

---

## 4) Ao ler/responder comentário, marcar notificação como lida

Fluxo sugerido:

1. consultar notificações ativas
2. responder comentário no card quando necessário
3. marcar notificação como lida/arquivada

```bash
pnpm cli --output json notifications --is-archived N
pnpm cli comment create --payload ./payloads/reply-comment.json --dry-run
pnpm cli comment create --payload ./payloads/reply-comment.json
pnpm cli notification read --payload ./payloads/notification-read.json --dry-run
pnpm cli notification read --payload ./payloads/notification-read.json
```

Sempre ajustar `notificationId` para a notificação tratada no fluxo atual.

---

## Checklist rápido para agente

- [ ] Tenho `flowId`, `cardId` e etapa atual identificados?
- [ ] Usei `flow_step.form_id` correto para `idForm` (não `form_init_id`)?
- [ ] Preenchi todos os campos `required = "1"` do formulário da etapa?
- [ ] Rodei `--dry-run` antes da mutação real?
- [ ] Registrei comentário de evidência no card?
- [ ] Marquei notificação relacionada como lida (quando aplicável)?
