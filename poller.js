/**
 * Confirmação de Envio — Relatório de Visitas (serviço de POLLING na VM).
 *
 * A cada POLL_MS a VM pergunta ao monday.com quais ATAS foram criadas desde a
 * última checagem (via activity_logs / evento create_pulse). Para cada item novo
 * cujo Contrato seja SEMSA ou SEDUC, envia a confirmação no respectivo grupo de
 * WhatsApp via Evolution API.
 *
 * SEM webhook (a VM tem IP privado, o Monday não a alcança) e SEM n8n — só faz
 * conexões de SAÍDA. Roda sob PM2. Node 18+ (usa fetch nativo).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MONDAY_TOKEN = (process.env.MONDAY_API_TOKEN || '').trim();
const BOARD_ID = (process.env.BOARD_ID || '18396759209').trim();
const EVO_URL = (process.env.EVOLUTION_URL || 'https://aionscorp-evolution.cloudfy.live').trim().replace(/\/+$/, '');
const EVO_INSTANCE = (process.env.EVOLUTION_INSTANCE || 'AIONS-MIKE').trim();
const EVO_APIKEY = (process.env.EVOLUTION_APIKEY || '').trim();
const POLL_MS = parseInt(process.env.POLL_MS || '60000', 10);
const OVERLAP_MS = parseInt(process.env.OVERLAP_MS || '120000', 10); // re-olha 2 min p/ trás
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');

const GRUPOS = {
  semsa: (process.env.GRUPO_SEMSA || '120363424825775173@g.us').trim(),
  seduc: (process.env.GRUPO_SEDUC || '120363409142232952@g.us').trim(),
};

// Títulos das colunas (case-insensitive, "contém"). Ajuste se renomearem.
const COL_TITLES = {
  contrato: ['contrato'],
  unidade: ['unidade'],
  objetivo: ['objeto da visita', 'objetivo', 'objeto'],
  data: ['data de realiza', 'data'],
};

function log(...a) { console.log(new Date().toISOString(), ...a); }
function norm(s) {
  return (s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

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
  };
}

async function createdItemIds(fromISO) {
  const d = await gql(
    `query ($b:[ID!]!,$from:ISO8601DateTime!){ boards(ids:$b){ activity_logs(from:$from, limit:200){ event data } } }`,
    { b: [BOARD_ID], from: fromISO }
  );
  const logs = ((d.boards || [])[0] || {}).activity_logs || [];
  const ids = [];
  for (const l of logs) {
    if (l.event !== 'create_pulse') continue;
    try {
      const dd = JSON.parse(l.data);
      if (dd.pulse_id) ids.push(String(dd.pulse_id));
    } catch (_) {}
  }
  return ids;
}

function fmtData(iso) {
  if (!iso) return '—';
  const p = iso.split('-');
  return p.length === 3 && p[0].length === 4 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
}

function montaMsg(c) {
  return (
    '*Mensagem de Confirmação de Envio (Relatório de Visitas)*\n\n' +
    `*ENCARREGADO RESPONSÁVEL:* ${c.name || '—'}\n` +
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

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function tick() {
  let st = loadState();
  // 1ª execução: marca o "agora" como baseline e NÃO processa histórico.
  if (!st || !st.lastCheck) {
    st = { lastCheck: new Date().toISOString(), notified: [] };
    saveState(st);
    log('baseline definido — histórico anterior ignorado.');
    return;
  }

  const fromISO = new Date(Date.parse(st.lastCheck) - OVERLAP_MS).toISOString();
  const nowISO = new Date().toISOString();

  let ids;
  try {
    ids = await createdItemIds(fromISO);
  } catch (e) {
    log('ERRO activity_logs:', e.message);
    return; // mantém lastCheck p/ tentar de novo na próxima
  }

  const notified = new Set(st.notified || []);
  for (const id of ids) {
    if (notified.has(id)) continue;
    try {
      const item = await getItem(id);
      if (!item) {
        notified.add(id);
        continue;
      }
      const jid = GRUPOS[norm(item.contrato)];
      if (jid) {
        await sendText(jid, montaMsg(item));
        log('ENVIADO', id, '|', item.contrato, '|', item.name);
      } else {
        log('ignorado', id, '| contrato:', item.contrato || '(vazio)');
      }
      notified.add(id);
    } catch (e) {
      log('FALHA item', id, ':', e.message); // não marca p/ retentar
    }
  }

  st.notified = Array.from(notified).slice(-5000);
  st.lastCheck = nowISO;
  saveState(st);
}

async function main() {
  if (!MONDAY_TOKEN || !EVO_APIKEY) {
    log('FALTA configurar MONDAY_API_TOKEN e/ou EVOLUTION_APIKEY. Abortando.');
    process.exit(1);
  }
  log(`confirmacao-visitas iniciado | board ${BOARD_ID} | poll ${POLL_MS}ms | grupos SEMSA/SEDUC`);
  await tick();
  setInterval(() => {
    tick().catch((e) => log('ERRO tick:', e.message));
  }, POLL_MS);
}

main();
