# Confirmação de Envio — Relatório de Visitas

Automação que **substitui o fluxo do n8n**. Quando uma ata é **criada** no board
`CONTROLE - ATAS DE REUNIÃO` (monday.com, board `18396759209`), se o **Contrato**
for **SEMSA** ou **SEDUC**, envia uma mensagem de confirmação no respectivo grupo
de WhatsApp via **Evolution API**.

```
Monday (board ATAS) --webhook--> Vercel (este app) --> Evolution API --> grupo WhatsApp
```

## Deploy na Vercel (via Git)

1. Suba este repositório no GitHub.
2. Na Vercel: **Add New → Project → Import** o repositório.
3. Em **Settings → Environment Variables**, configure (Production):

   | Variável | Valor |
   |---|---|
   | `MONDAY_API_TOKEN` | token de API da conta contato-serv (acesso ao board ATAS) |
   | `MONDAY_WEBHOOK_TOKEN` | uma string secreta longa (a mesma vai na URL do webhook) |
   | `EVOLUTION_URL` | `https://aionscorp-evolution.cloudfy.live` |
   | `EVOLUTION_INSTANCE` | `AIONS-MIKE` |
   | `EVOLUTION_APIKEY` | apikey da Evolution |
   | `GRUPO_SEMSA` | `120363424825775173@g.us` (opcional, já é default) |
   | `GRUPO_SEDUC` | `120363409142232952@g.us` (opcional, já é default) |

4. **Deploy**. A URL pública será algo como `https://<projeto>.vercel.app`.

## Registrar o webhook no Monday

Apontar o board para a URL pública, com o token na query string:

```
https://<projeto>.vercel.app/api/monday-webhook?token=<MONDAY_WEBHOOK_TOKEN>
```

Registro via API (evento `create_item`):

```graphql
mutation {
  create_webhook(board_id: 18396759209,
    url: "https://<projeto>.vercel.app/api/monday-webhook?token=<TOKEN>",
    event: create_item) { id board_id }
}
```

O app responde ao handshake `challenge` do Monday automaticamente.

## Endpoints

- `GET /` — health check.
- `POST /api/monday-webhook?token=...` — recebe o evento do Monday.

## Mapeamento de colunas (por título, case-insensitive)

| Campo da mensagem | Coluna no Monday |
|---|---|
| ENCARREGADO RESPONSÁVEL | nome do item |
| CONTRATO | `Contrato` (status) |
| UNIDADE | `Unidade` (dropdown) |
| OBJETO DA VISITA | `Objetivo` (status) |
| DATA DE REALIZAÇÃO | `Data de Realização` (date) |

Só **SEMSA** e **SEDUC** disparam mensagem; outros contratos são ignorados.

## Alternativa: rodar na VM (sem Vercel)

`poller.js` é uma versão por **polling** (a VM consulta o Monday a cada ~1 min),
para rodar sob PM2 na VM sem expor nada à internet. Não é usada no deploy Vercel.
Variáveis: as mesmas acima (via ambiente do processo).
```
pm2 start poller.js --name confirmacao-visitas
```
