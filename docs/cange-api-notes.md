# Cange API notes (cange-agent-kit)

## Base e autenticação

- Base URL padrão: `https://api.cange.me`
- Origin padrão: `https://app.cange.me`
- Auth header: `Authorization: Bearer <token>`
- Login público: `POST /session` com `email` + `apikey`

## Endpoints suportados no kit

### Discovery e estrutura

- `GET /flow/my-flows`
- `GET /register/my-registers`
- `GET /card/my-tasks`
- `GET /notification/by-user` (`isArchived=S|N`)
- `POST /notification` (`id_notification`, `archived`)
- `GET /flow` (`id_flow` ou `hash`)
- `GET /register` (`id_register` ou `hash`)
- `GET /field/by-flow` (`flow_id`)
- `GET /field/by-register` (`register_id`, `typeFilter?`, `withChildren?`)

### Fluxos / Cards

- `POST /form/new-answer` (create card)
- `PUT /card` (update card atributos)
- `PUT /form/answer` (update card values)
- `POST /card/v2/move-step` (move card step; enviar sempre `id_form` e `values`, mesmo `values = {}`)
- `GET /card/`
- `GET /card/by-flow/`

### Comentários

- `POST /card-comment`

### Arquivos

- `POST /attachment` (multipart)
- `POST /attachment/card`

### Registers

- `GET /form/answer/`
- `POST /form/new-answer`
- `PUT /form/answer`

## Resiliência de modelagem

- O kit preserva `raw` de respostas para evitar perda de informação.
- Os summaries (`flow`, `register`, `card`, `fields`) usam extração defensiva.
- Não há suposição rígida única de shape (`data`, `items`, `results`, etc.).

## Incertezas documentadas

- A resposta de `/session` pode variar; o kit busca token de forma resiliente (`token`, `access_token`, `accessToken`, nested).
- O shape de `/form/answer/` pode variar por contexto; o kit retorna `raw` integral e não força tipagem rígida.
