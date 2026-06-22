"""Confirmação de Envio — Relatório de Visitas.

Recebe o webhook do monday.com (board CONTROLE - ATAS DE REUNIÃO) quando um
item (ata) é criado, lê os campos do item e, se o Contrato for SEMSA ou SEDUC,
manda uma mensagem de confirmação no respectivo grupo de WhatsApp via Evolution.

Sem n8n. Roda como função serverless na Vercel (@vercel/python).
"""
from __future__ import annotations

import os
import unicodedata

from flask import Flask, jsonify, request

import monday_client
import evolution

app = Flask(__name__)


def _norm(value: str | None) -> str:
    s = (value or "").strip().lower()
    return "".join(
        c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn"
    )


# Contrato (normalizado) -> JID do grupo de WhatsApp. Sobrescrevível por env
# (GRUPO_SEMSA / GRUPO_SEDUC) sem precisar mexer no código.
def _grupos() -> dict[str, str]:
    return {
        "semsa": os.environ.get("GRUPO_SEMSA", "120363424825775173@g.us").strip(),
        "seduc": os.environ.get("GRUPO_SEDUC", "120363409142232952@g.us").strip(),
    }


def _fmt_data(iso: str | None) -> str:
    """'2026-02-04' -> '04/02/2026' (deixa como veio se não for ISO)."""
    if not iso:
        return "—"
    parts = iso.split("-")
    if len(parts) == 3 and len(parts[0]) == 4:
        return f"{parts[2]}/{parts[1]}/{parts[0]}"
    return iso


def _montar_mensagem(ctx: dict) -> str:
    return (
        "*Confirmação de Envio — Relatório de Visitas*\n\n"
        f"*ENCARREGADO RESPONSÁVEL:* {ctx.get('name') or '—'}\n"
        f"*CONTRATO:* {ctx.get('contrato') or '—'}\n"
        f"*UNIDADE:* {ctx.get('unidade') or '—'}\n"
        f"*OBJETO DA VISITA:* {ctx.get('objetivo') or '—'}\n"
        f"*DATA DE REALIZAÇÃO:* {_fmt_data(ctx.get('data_realizacao'))}"
    )


@app.get("/")
def health():
    return jsonify({"ok": True, "service": "confirmacao-visitas"})


@app.post("/api/monday-webhook")
def monday_webhook():
    payload = request.get_json(silent=True) or {}

    # 1) Handshake do Monday: ecoa o "challenge" na configuração do webhook.
    if "challenge" in payload:
        return jsonify({"challenge": payload["challenge"]})

    # 2) Autenticação por token na query string (?token=...), pois o webhook
    #    nativo do Monday não envia headers customizados.
    expected = os.environ.get("MONDAY_WEBHOOK_TOKEN", "").strip()
    if expected and request.args.get("token", "") != expected:
        return jsonify({"error": "Não autorizado."}), 401

    event = payload.get("event") or {}
    item_id = event.get("pulseId") or event.get("itemId")
    if not item_id:
        return jsonify({"ok": True, "ignored": "sem pulseId no evento"}), 200

    # 3) Lê o item no Monday.
    try:
        ctx = monday_client.get_visit_item(item_id)
    except monday_client.MondayError as exc:
        return jsonify({"ok": False, "erro_monday": str(exc)}), 200

    # 4) Só SEMSA/SEDUC disparam mensagem.
    contrato = _norm(ctx.get("contrato"))
    grupo = _grupos().get(contrato)
    if not grupo:
        return jsonify({
            "ok": True,
            "ignored": f"contrato fora do escopo: {ctx.get('contrato') or '(vazio)'}",
            "item_id": str(item_id),
        }), 200

    # 5) Manda a confirmação no grupo certo.
    texto = _montar_mensagem(ctx)
    try:
        res = evolution.send_text(grupo, texto)
    except evolution.EvolutionError as exc:
        return jsonify({"ok": False, "erro_evolution": str(exc), "item_id": str(item_id)}), 200

    return jsonify({
        "ok": True,
        "enviado": True,
        "contrato": ctx.get("contrato"),
        "grupo": grupo,
        "item_id": str(item_id),
        "evolution": res.get("key") or res,
    }), 200


if __name__ == "__main__":
    app.run(port=int(os.environ.get("FLASK_PORT", "5000")), debug=True)
