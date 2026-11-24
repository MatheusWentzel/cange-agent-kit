# Playbook 06: Construir fluxo do zero (Flow V2 Build API)

Use este playbook para criar/alterar fluxos, etapas, campos e relacionamentos via a Flow V2 Build API (prefixo `/flow/v2/build`). Todos os comandos abaixo estão expostos sob `cange flow-build ...`. As condicionais (`flow-build conditional`) usam a rota da tela, `/conditional`, e não a Build API.

## Princípios obrigatórios

- Use **somente** `pnpm cli flow-build ...` (nunca `curl` direto). Vale em especial para condicional: regra montada à mão é avaliada certo no cartão e mesmo assim não abre no editor da tela.
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
8. Condicionais, **depois** de todos os campos e opções existirem: `pnpm cli flow-build conditional create ...` e conferir com `pnpm cli flow-build conditional list --id-flow <id>` (`notOpenable` precisa ser 0).
9. Para inspecionar um nó específico: `pnpm cli flow-build step-relationship from --id-flow <id> --id-step <parent>`.

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

### `flow-build conditional` (campo e etapa)

O kit busca o campo de origem, valida e monta `conditions_items` no formato exato da tela. Ninguém monta esse JSON à mão: o editor lê a lista de valores de `selectedField.options`, e uma regra gravada só com id, nome e tipo abre com a lista carregando para sempre.

```bash
# Ler (não grava): do fluxo, de um campo ou de um par de etapas
pnpm cli flow-build conditional list --id-flow 123
pnpm cli flow-build conditional list --id-flow 123 --id-field 456
pnpm cli flow-build conditional list --id-flow 123 --id-step 22 --id-step-from 11

# Criar em campo: exibir o campo 456 quando Tipo for Externo (sempre --dry-run antes)
pnpm cli flow-build conditional create --id-flow 123 --id-field 456 --action exibir \
  --when '{"field":"Tipo","comparator":"Igual a","value":"Externo"}' --dry-run

# Criar em etapa: impedir mover de 11 para 22
pnpm cli flow-build conditional create --id-flow 123 --id-step 22 --id-step-from 11 --action bloquear \
  --when '{"field":"Valor","comparator":"Maior que","value":1000}'

# Alterar no lugar (mesmo id): só a ação, ou todas as condições, ou só consertar o formato
pnpm cli flow-build conditional update --id-flow 123 --id-conditional 789 --action esconder
pnpm cli flow-build conditional update --id-flow 123 --id-conditional 789 --rehydrate
```

| Parâmetro | Regra |
|-----------|-------|
| `--action` | Campo: `exibir` (1) ou `esconder` (2). Etapa: `permitir` (1) ou `bloquear` (2) |
| `--when <json>` | Uma condição; repita para várias (todas precisam valer). `{ field, comparator, value }` ou `{ field, comparator, values }` |
| `--payload <path>` | No lugar de `--action` e `--when`: `{ action, conditions[] }` (`examples/flow-build-conditional.example.json`) |
| `field` | Id, hash ou título. Padrão: `-1` vencimento, `-2` criação, `-3` responsável, `-4` etapa |
| `value` de opção | Rótulo ou código. Se o texto é código de uma opção e rótulo de outra, use `{"code":"2"}` ou `{"label":"2"}` |
| `value` de usuário | Id, nome, e-mail, ou `-1` (usuário logado) |
| `value` de cadastro e de cartão | Id da entrada ou do cartão, conferido contra o vínculo do campo |
| `value` de data | `dd/MM/yyyy` ou `yyyy-MM-dd`. Atalho relativo (hoje, esta semana) é recusado: o avaliador não o calcula |

Comparadores por tipo:

- **Opção** (seleção, rádio, checkbox, usuário, solicitante, cadastro, cartão, lista): `Igual a`, `Não é igual a`, `É uma das`, `Não é uma das`, `Está em branco`, `Não está em branco`. Só `É uma das` e `Não é uma das` aceitam mais de um valor.
- **Texto** (curto, longo, rico, e-mail, telefone, documento, link, id): `Contém`, `Não contém`, `Igual a`, `Não é igual a`, `Está em branco`, `Não está em branco`.
- **Número** (número, moeda, fórmula): `Igual a`, `Menor que`, `Maior que`, `Igual a ou maior que`, `Igual a ou menor que`, `Não é igual a`, `Está em branco`, `Não está em branco`. Número e moeda com ponto decimal.
- **Data** (data, vencimento, `-1`, `-2`): `Igual a`, `Antes de`, `Depois de`, `Igual a ou depois`, `Igual a ou antes`, `Não é igual a`, `Está em branco`, `Não está em branco`.
- **Switch**: só `Igual a`, com `true` ou `false`.

Recusado antes de gravar (exit 2): valor fora das opções; campo de opção sem opções (ou sem o vínculo, nos tipos de lista dinâmica); comparador de outro tipo; campo de origem, campo alvo ou etapa fora do fluxo; título repetido (informe o id); tipo sem filtro na tela (cor, ícone, anexo, título); Data de Conclusão (`-9`), que a tela não oferece e o avaliador ignora.

Depois de gravar, o kit relê a regra e responde `verified`. `verified: false` = gravou, mas a releitura falhou: confira com `list`. Se a API não responder, **não repita o `create`** sem antes rodar `list` (a regra pode ter sido gravada).

`list` marca cada regra com `opensInEditor`; quando `false`, `editorIssues` diz o motivo e `update --rehydrate` conserta no lugar, se o valor antigo ainda existir nas opções. Nos tipos de lista dinâmica (usuário, cadastro, cartão) o `list` confere o vínculo, não o valor.

Ler o efeito no formulário: `show_on_form: "S"` significa **escondido**. Com ação `exibir`, o campo fica escondido até a condição valer. A primeira regra verdadeira, na ordem da tela, vence.

Limites do avaliador da tela que o kit não corrige (a tela também deixa criar): data com `Não é igual a` é sempre verdadeira, e `Está em branco` em `-1` e `-2` não casa com data vazia. Evite os dois.

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
- Montar `conditions_items` / `selectedField` à mão ou chamar `POST /conditional` direto (use `flow-build conditional`).
- Apagar e recriar condicional que o editor não abre (use `update --rehydrate`, que mantém o id e a ordem).
