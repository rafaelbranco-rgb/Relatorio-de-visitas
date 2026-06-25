// Webhook do monday.com -> Evolution API (confirmação de visita).
//
// Fonte: board "Relatório de Visitas" (OPERAÇÕES). Dispara a CADA novo relatório
// criado. Responde 200 IMEDIATAMENTE pro Monday (evita timeout/retry => sem
// duplicata) e processa a leitura do item + envio no WhatsApp em background.
//
// Teste seguro: POST com ?dryRun=1 processa e RETORNA a mensagem montada SEM
// enviar no WhatsApp (não polui o grupo).
import { waitUntil } from '@vercel/functions';

const MONDAY_TOKEN = (process.env.MONDAY_API_TOKEN || '').trim();
const EVO_URL = (process.env.EVOLUTION_URL || 'https://aionscorp-evolution.cloudfy.live').trim().replace(/\/+$/, '');
const EVO_INSTANCE = (process.env.EVOLUTION_INSTANCE || 'AIONS-MIKE').trim();
const EVO_APIKEY = (process.env.EVOLUTION_APIKEY || '').trim();

const GRUPOS = {
  semsa: (process.env.GRUPO_SEMSA || '120363424825775173@g.us').trim(),
  seduc: (process.env.GRUPO_SEDUC || '120363409142232952@g.us').trim(),
};

// Colunas casadas por TÍTULO (resiliente a mudança de id). No board novo:
// Contrato, Unidade, Objetivo da Visita, Data de Visita, Responsável pela Visita.
const COL_TITLES = {
  contrato: ['contrato'],
  unidade: ['unidade'],
  objetivo: ['objetivo', 'objeto'],
  data: ['data de visita', 'data de realiza', 'data'],
  responsavel: ['respons'], // "Responsável pela Visita"
};

const norm = (s) => (s || '').trim().toLowerCase();

async function gql(query, variables) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { Authorization: MONDAY_TOKEN, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.errors) throw new Error('Monday: ' + JSON.stringify(b.errors || ('HTTP ' + r.status)));
  return b.data || {};
}

function matchCol(columns, titles) {
  for (const c of columns) {
    const t = (c.title || '').toLowerCase();
    if (titles.some((x) => t.includes(x))) return c;
  }
  return null;
}

async function getItem(id) {
  const d = await gql(
    `query ($ids:[ID!]!){ items(ids:$ids){ id name board{ columns{ id title } } column_values{ id text } } }`,
    { ids: [String(id)] }
  );
  const it = (d.items || [])[0];
  if (!it) return null;
  const cols = (it.board && it.board.columns) || [];
  const cv = {};
  for (const v of it.column_values || []) cv[v.id] = v.text;
  const txt = (titles) => {
    const c = matchCol(cols, titles);
    return c ? cv[c.id] || null : null;
  };
  return {
    id: String(it.id),
    name: it.name,
    contrato: txt(COL_TITLES.contrato),
    unidade: txt(COL_TITLES.unidade),
    objetivo: txt(COL_TITLES.objetivo),
    data: txt(COL_TITLES.data),
    responsavel: txt(COL_TITLES.responsavel),
  };
}

function fmtData(iso) {
  if (!iso) return '—';
  // O board novo manda "2026-04-27 09:00" (com hora); pega só a parte da data.
  const datePart = String(iso).split(' ')[0].split('T')[0];
  const p = datePart.split('-');
  return p.length === 3 && p[0].length === 4 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
}

// Mapeia o contrato para o grupo: SEMSA -> grupo SEMSA; qualquer SEDUC
// (SEDUC SEDE / SEDUC ESCOLA) -> grupo SEDUC. Outros (DETRAN/CETAM/TRE PB) = ignora.
function grupoDoContrato(contrato) {
  const c = norm(contrato);
  if (c.startsWith('semsa')) return GRUPOS.semsa;
  if (c.startsWith('seduc')) return GRUPOS.seduc;
  return null;
}

function montaMsg(c) {
  return (
    '*Mensagem de Confirmação de Envio (Relatório de Visitas)*\n\n' +
    `*ENCARREGADO RESPONSÁVEL:* ${c.responsavel || c.name || '—'}\n` +
    `*CONTRATO:* ${c.contrato || '—'}\n` +
    `*UNIDADE:* ${c.unidade || '—'}\n` +
    `*OBJETIVO:* ${c.objetivo || '—'}\n` +
    `*DATA DE REALIZAÇÃO:* ${fmtData(c.data)}`
  );
}

async function sendText(jid, text) {
  const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: { apikey: EVO_APIKEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: jid, text }),
  });
  if (!r.ok) throw new Error('Evolution HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json().catch(() => ({}));
}

async function processar(itemId, dryRun = false) {
  const item = await getItem(itemId);
  if (!item) {
    console.log('item não encontrado', itemId);
    return { ok: false, reason: 'item-nao-encontrado' };
  }
  const jid = grupoDoContrato(item.contrato);
  if (!jid) {
    console.log('ignorado', itemId, '| contrato:', item.contrato || '(vazio)');
    return { ok: true, ignored: true, contrato: item.contrato || null };
  }
  const msg = montaMsg(item);
  if (dryRun) {
    console.log('DRYRUN', itemId, '->', jid);
    return { ok: true, dryRun: true, jid, contrato: item.contrato, msg };
  }
  await sendText(jid, msg);
  console.log('ENVIADO', itemId, '|', item.contrato, '|', item.responsavel || item.name);
  return { ok: true, sent: true, jid };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'confirmacao-visitas' });

  const body = req.body || {};

  // 1) Handshake do Monday.
  if (body.challenge) return res.status(200).json({ challenge: body.challenge });

  // 2) Auth por token na query string.
  const expected = (process.env.MONDAY_WEBHOOK_TOKEN || '').trim();
  if (expected && (req.query.token || '') !== expected) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  const event = body.event || {};
  const itemId = event.pulseId || event.itemId;
  if (!itemId) return res.status(200).json({ ok: true, ignored: 'sem pulseId' });

  // 3) Modo de teste: processa e devolve o resultado SEM enviar.
  if (req.query.dryRun) {
    try {
      const result = await processar(itemId, true);
      return res.status(200).json(result);
    } catch (e) {
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // 4) ACK imediato + processa em background (sem segurar a resposta).
  waitUntil(processar(itemId).catch((e) => console.error('FALHA proc', itemId, ':', e.message)));
  return res.status(200).json({ ok: true, queued: String(itemId) });
}
