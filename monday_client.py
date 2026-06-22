"""Cliente mínimo da API do monday.com (GraphQL) para a confirmação de visitas.

Lê o item (ata de visita) pelo seu id e devolve os campos relevantes,
casando as colunas pelo TÍTULO (case-insensitive, "contém") — assim a
automação não quebra se o id interno da coluna mudar.

Requer a variável de ambiente ``MONDAY_API_TOKEN`` (token de API de uma conta
com acesso ao board CONTROLE - ATAS DE REUNIÃO).
"""
from __future__ import annotations

import json
import os
import unicodedata
from typing import Any

import requests

MONDAY_API = "https://api.monday.com/v2"

# Títulos das colunas no board (case-insensitive, "contém"). Ajuste aqui se
# renomearem as colunas no Monday.
CONTRATO_COL_TITLES = ("contrato",)
UNIDADE_COL_TITLES = ("unidade",)
OBJETIVO_COL_TITLES = ("objeto da visita", "objetivo", "objeto")
DATA_COL_TITLES = ("data de realiza", "data de realizacao", "data")


def _norm(value: str | None) -> str:
    s = (value or "").strip().lower()
    return "".join(
        c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn"
    )


class MondayError(RuntimeError):
    pass


def _token() -> str:
    token = os.environ.get("MONDAY_API_TOKEN", "").strip()
    if not token:
        raise MondayError("MONDAY_API_TOKEN não configurada no servidor.")
    return token


def _gql(query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
    resp = requests.post(
        MONDAY_API,
        data=payload,
        headers={
            "Authorization": _token(),
            "Content-Type": "application/json; charset=utf-8",
        },
        timeout=30,
    )
    try:
        body = json.loads(resp.content.decode("utf-8", "replace"))
    except ValueError as exc:
        raise MondayError(f"Resposta inválida do Monday (HTTP {resp.status_code}).") from exc
    if resp.status_code >= 400 or body.get("errors"):
        msg = body.get("errors") or body.get("error_message") or resp.text[:300]
        raise MondayError(f"Erro na API do Monday: {msg}")
    return body.get("data") or {}


def _match_col(columns: list[dict[str, Any]], titles: tuple[str, ...]) -> dict[str, Any] | None:
    for col in columns:
        title = (col.get("title") or "").strip().lower()
        if any(t in title for t in titles):
            return col
    return None


def get_visit_item(item_id: str | int) -> dict[str, Any]:
    """Lê o item da ata: nome (responsável), contrato, unidade, objetivo e data."""
    data = _gql(
        """
        query ($ids: [ID!]!) {
          items (ids: $ids) {
            id
            name
            url
            board { id columns { id title type } }
            column_values { id text value }
          }
        }
        """,
        {"ids": [str(item_id)]},
    )
    items = data.get("items") or []
    if not items:
        raise MondayError(f"Item {item_id} não encontrado.")
    item = items[0]
    board = item.get("board") or {}
    columns = board.get("columns") or []
    col_values = {cv["id"]: cv for cv in (item.get("column_values") or [])}

    def _txt(titles: tuple[str, ...]) -> str | None:
        col = _match_col(columns, titles)
        if not col:
            return None
        return (col_values.get(col["id"], {}) or {}).get("text") or None

    return {
        "item_id": str(item.get("id")),
        "board_id": str(board.get("id")),
        "name": item.get("name"),          # Encarregado responsável = nome do item
        "url": item.get("url"),
        "contrato": _txt(CONTRATO_COL_TITLES),
        "unidade": _txt(UNIDADE_COL_TITLES),
        "objetivo": _txt(OBJETIVO_COL_TITLES),
        "data_realizacao": _txt(DATA_COL_TITLES),
    }
