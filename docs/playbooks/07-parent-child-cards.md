# Playbook 07: Cards pai-filho via "Meus Fluxos" (COMBO_BOX_FLOW_FIELD)

Modela a relação 1-N entre fluxos: um card-pai referencia N cards-filho em outro fluxo, através de um campo do tipo "Meus Fluxos" (`COMBO_BOX_FLOW_FIELD`).

## Como o vínculo é armazenado (importante)

- O campo "Meus Fluxos" vive no **pai** e aponta para o **fluxo-filho** (`field.flow_id` = id do fluxo-filho).
- É **multi-valor**: cada filho vinculado é **uma linha `form_answer_field`** cujo `value` = `id_card` do filho. Não é um JSON array numa linha só.
- **Os read-models não expõem esse vínculo**: `card get` (`/card/`, `/card/o/`) e FlowQuery V2 **não** trazem o id do filho. A leitura confiável é via `card relationship` (lê direto da `form_answer_field`).

## Comandos

### Ler os pais de um card (filho → pai)

```bash
pnpm cli --output json card relationship --flow-id <fluxo-filho> --card-id <id-do-filho>
```

Retorna os cards-pai que referenciam esse filho. `--no-with-cards` traz só os vínculos.

### Criar um filho e vincular ao pai

```bash
pnpm cli card add-child --payload <add-child.json>   # use --dry-run antes
```

```json
{
  "child":  { "flowId": 21173, "idForm": 146224, "origin": "/cange-agent-kit", "values": { "<hash>": "..." } },
  "parent": { "flowId": 21157, "cardId": 1070844, "idForm": 146120,
              "linkField": "<hash do campo Meus Fluxos>", "existingChildIds": [1081809] }
}
```

O comando: (1) cria o card filho no `child.flowId`; (2) faz **read-modify-write** no campo do pai, enviando `[...existingChildIds, novoId]`.

## Regra crítica: o campo é REPLACE, não append

`update-values`/`add-child` **substituem** o conjunto inteiro do campo multi-valor. Para **não apagar** os filhos já vinculados, **sempre** passe `parent.existingChildIds` com os filhos atuais (read-modify-write). Omitir = só o novo filho (caso "primeiro filho").

- Para obter os filhos atuais de forma confiável: varra o fluxo-filho (`card by-flow` / FlowQuery V2 — campos do filho são legíveis) e confirme o vínculo com `card relationship` por candidato; ou mantenha a lista acumulada quando criar vários de uma vez (caso kickoff: crie todos e vincule numa só chamada com o array completo).

## Formato de `values` por tipo de campo (descoberto em produção)

| Tipo | Formato no `values` |
|---|---|
| Texto / Texto longo / Rich text | string |
| `COMBO_BOX_FIELD` / `RADIO_BOX_FIELD` | código string (`"1"`) |
| `DATE_PICKER_FIELD` / `DUE_DATE_FIELD` | **datetime ISO completo** (`2026-06-30T12:00:00.000Z`) — só data dá 400 |
| `COMBO_BOX_USER_FIELD` | **e-mail** do usuário, não o id |
| `CURRENCY_FIELD` / `NUMBER_FIELD` | **número** (não string) |
| `COMBO_BOX_REGISTER_FIELD` / `COMBO_BOX_FLOW_FIELD` | **array** de ids (`[2812477]`, `[1081809]`) |

## Armadilhas

- Limpar o campo enviando `[]` (array vazio) → **500** no servidor. Para remover um filho, reescreva o array sem o id dele.
- `--validate-fields` pode dar "JWT token is missing" (falso-negativo) — usar `--dry-run` puro; a mutação real funciona.
