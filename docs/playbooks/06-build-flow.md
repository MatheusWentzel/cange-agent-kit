# Playbook 06: Construir fluxo do zero (Flow V2 Build API)

Use este playbook para criar/alterar fluxos, etapas, campos e relacionamentos via a Flow V2 Build API (prefixo `/flow/v2/build`). Todos os comandos abaixo estão expostos sob `cange flow-build ...`.

## Princípios obrigatórios

- Use **somente** `pnpm cli flow-build ...` (nunca `curl` direto).
- Bodies são **strict**: chaves extras causam `VALIDATION_FAILED`. Envie apenas o que o schema aceita.
- Para **qualquer** rota com `:id_flow`, o token precisa ser **administrador** daquele fluxo (`flow_user.type = 'A'`). 404 com `FLOW_NOT_FOUND` significa “sem permissão ou fluxo inexistente” — não exponha dados.
- Quem cria o fluxo (`flow create`) é registrado automaticamente como admin `'A'`.
- `--payload` aceita **somente caminho de arquivo JSON**. Nunca JSON inline.
- Use `--dry-run` para validar o body localmente sem chamar a API.
- Diferente das APIs de card/register, a Build API **não** recebe `values`. Os bodies usam chaves snake_case (`form_init_id`, `flow_step_id`, `step_available_id`, `isActive` etc.) exatamente como definidas no schema do servidor.

## Ordem recomendada de construção

1. `pnpm cli flow-build flow create --payload <create-flow.json>`
   - guardar `id_flow` e `form_init_id` do retorno.
2. (opcional) `pnpm cli flow-build flow update --id-flow <id> --payload <update-flow.json>` para ajustar metadados.
3. Para cada etapa: `pnpm cli flow-build step create --id-flow <id> --payload <create-step.json>`
   - guardar `id_step` e `form_id` de cada etapa.
4. (opcional) Reordenar com `pnpm cli flow-build step reorder --id-flow <id> --payload <reorder.json>` (`{ id_step, upDown: "up" | "down" }`).
5. Para cada aresta entre etapas: `pnpm cli flow-build step-relationship set --id-flow <id> --payload <rel.json>` (`isActive: "1"` para permitir; `"0"` para bloquear).
6. Para cada campo:
   - No formulário inicial: `pnpm cli flow-build field create --id-flow <id> --form-id <form_init_id> --payload <field.json>`.
   - Em um form de etapa: `pnpm cli flow-build field create --id-flow <id> --id-step <id_step> --payload <field.json>` (server resolve o form da etapa).
7. Verificar o grafo: `pnpm cli flow-build step-relationship list --id-flow <id>` (todas as etapas com `relationship_steps` + `conditionals`).
8. Para inspecionar um nó específico: `pnpm cli flow-build step-relationship from --id-flow <id> --id-step <parent>`.

## Descoberta antes de criar campos

```bash
pnpm --silent cli --output json flow-build field-types list
pnpm --silent cli --output json flow-build field-types get --type TEXT_SHORT_FIELD
```

- `list` devolve `{ types, schema_version }` (catálogo aceito pela API).
- `get --type <TIPO>` devolve o `FieldTypeDescriptor` com `properties[]` (chave, valueType, required, enumValues, descrição).
- Tipos **fora** do catálogo: `PASSWORD_FIELD`, `COMBO_BOX_REGISTER_FIELD`, `COMBO_BOX_FLOW_FIELD` (rejeitados — não enviar).

## Schema dos comandos (resumo)

### `flow-build flow create`

| Chave | Tipo | Observações |
|-------|------|-------------|
| `workspace_id` | int>0 opcional | Associa o fluxo ao workspace |
| `name` | string opcional | |
| `color` | string opcional | Default `#f23b5c` no servidor |
| `icon` | string opcional | Padrão `Fa[A-Za-z0-9]+`; senão default `FaCodeBranch` |
| `button_add_name` | string opcional | |
| `isPrivate` | `'0'` / `'1'` opcional | Default `'1'` |
| `isAllowedArchive` | `'S'` / `'N'` opcional | Default `'S'` |
| `isAllowedDelete` | `'S'` / `'N'` opcional | Default `'S'` |

### `flow-build flow update`

Aceita ≥1 das chaves: `rascunho`, `name`, `color`, `icon`, `form_init_id`, `button_add_name`, `isPrivate`, `email_type`, `company_email_config_id` (int>0 ou `null`), `schema_view`, `isAllowedListEdit`, `isAllowedArchive`, `isAllowedDelete`, `card_layout_schema`.

### `flow-build step create`

`name` é obrigatório. Outros opcionais: `form_name` (default `STP {name}`), `index`, `color`, `icon`, flags (`isAddable`, `isEndStep`, `isRequiredTrack`, `isRestrictMove` em `'0'`/`'1'`), `description`, `user_id_owner`, `due_time_type`, `due_time`, `due_time_bd`.

### `flow-build step update`

Subconjunto dos campos de criação + nulláveis para `user_id_owner`, `due_time_type`, `due_time`, `due_time_bd`. Mínimo 1 chave.

### `flow-build step reorder`

```json
{ "id_step": 78901, "upDown": "up" }
```

### `flow-build field create` / `flow-build field update`

Base comum (criação):

- `name` (string, obrigatório)
- `type` (literal do catálogo, obrigatório — imutável após criação)
- `title` (string, recomendado)
- `index` (int ≥ 0, obrigatório)
- `description`, `placeholder`, `help_text` (string opcional)
- `required` (`'0'` / `'1'`, default conforme tipo)
- `validation_type`, `variation` (string opcional, depende do tipo)
- `formula` (string opcional, apenas `FORMULA_FIELD` — não pode conter `[` nem `]`; placeholders `{nome}`)
- `options` (`[{ value, label, hide?, order?, id_field_option? }]`, obrigatório não vazio para `COMBO_BOX_FIELD`, `RADIO_BOX_FIELD`, `CHECK_BOX_FIELD`)
- `validations` (`[{ type, params }]`, opcional; não enviar `type: "required"` para campos sem resposta)
- `filter_schema` (string JSON opcional — relevante para `COMBO_BOX_USER_FIELD`, `REQUESTER_FIELD`)
- `register_id`, `flow_id` (int>0 opcional)

#### Tipos sem resposta (campos de layout)

`BUTTON_FIELD`, `TITLE_FIELD`, `DESCRIPTION_FIELD`, `DIVIDER_FIELD`:

- `required` deve ser `'0'` (nunca `'N'`).
- Não enviar validação `type: "required"`.

#### Patch (`update`)

- Body strict, ≥1 chave.
- **Não** enviar `type` (imutável).
- Para limpar listas (`options`/`validations`), envie a forma final desejada — o servidor faz merge.

### `flow-build step-relationship set`

```json
{
  "flow_step_id": 123,
  "step_available_id": 456,
  "isActive": "1"
}
```

- `isActive: "1"` — aresta ativa (permite movimentação A→B).
- `isActive: "0"` — aresta inativa (bloqueio explícito; útil para regras “não mover A→B”).
- `flow_id` vem da URL: **não** envie no body.

### `flow-build step-relationship list` / `from`

- `list --id-flow <id>` → array de `FlowStep` ordenado por `index` com `relationship_steps[]` (aresta partindo da etapa) e `conditionals[]`.
- `from --id-flow <id> --id-step <parent>` → todas as etapas; cada uma traz `step_relationship` (join como destino a partir do pai) e `conditionals` filtrados. Quando não existe linha persistida, o servidor sintetiza `{ id_step_relationship: 0, isActive: '1' }`.

## Erros frequentes da API

- `VALIDATION_FAILED` — body inválido ou chaves extras. Releia o schema do recurso.
- `FIELD_TYPE_UNKNOWN` — `type` não está no catálogo. Use `flow-build field-types list`.
- `FLOW_NOT_FOUND` — token não é admin do fluxo, ou ID inexistente.
- `STEP_NOT_FOUND` / `FORM_NOT_IN_FLOW` — recurso fora do fluxo informado.
- `EMAIL_CONFIG_NOT_FOUND` — `company_email_config_id` inexistente na empresa do token.
- `INTERNAL_ERROR` / `CONFLICT` / `REQUEST_FAILED` — falhas na transação de etapa; revise dependências (etapa referenciada, índice, ordem).

## Anti-padrões proibidos

- Enviar chaves extras “por precaução” (body é strict).
- Tentar mudar `type` de um campo via PATCH.
- Usar `'N'` no `required` de `BUTTON_FIELD` / `TITLE_FIELD` / `DESCRIPTION_FIELD` / `DIVIDER_FIELD` (use `'0'`).
- Usar `[` / `]` em `formula` de `FORMULA_FIELD`.
- Criar campo `COMBO_BOX_FIELD` / `RADIO_BOX_FIELD` / `CHECK_BOX_FIELD` com `options` vazio.
- Misturar `--id-step` e `--form-id` no mesmo `field create` (use um único alvo).
- Repetir `flow_id` no body de `step-relationship set` (já vem da URL).
