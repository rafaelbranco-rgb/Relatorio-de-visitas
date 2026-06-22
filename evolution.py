"""Envio de mensagem de texto via Evolution API (WhatsApp).

Requer as variáveis de ambiente:
  EVOLUTION_URL       ex.: https://aionscorp-evolution.cloudfy.live
  EVOLUTION_INSTANCE  ex.: AIONS-MIKE
  EVOLUTION_APIKEY    chave global/da instância
"""
from __future__ import annotations

import os

import requests


class EvolutionError(RuntimeError):
    pass


def _cfg() -> tuple[str, str, str]:
    url = os.environ.get("EVOLUTION_URL", "").strip().rstrip("/")
    instance = os.environ.get("EVOLUTION_INSTANCE", "").strip()
    apikey = os.environ.get("EVOLUTION_APIKEY", "").strip()
    if not (url and instance and apikey):
        raise EvolutionError("EVOLUTION_URL/INSTANCE/APIKEY não configurados no servidor.")
    return url, instance, apikey


def send_text(number: str, text: str) -> dict:
    """Envia texto para um número/JID (ex.: '120363...@g.us' de um grupo)."""
    url, instance, apikey = _cfg()
    resp = requests.post(
        f"{url}/message/sendText/{instance}",
        headers={"apikey": apikey, "Content-Type": "application/json"},
        json={"number": number, "text": text},
        timeout=30,
    )
    if resp.status_code >= 400:
        raise EvolutionError(f"Evolution HTTP {resp.status_code}: {resp.text[:300]}")
    try:
        return resp.json()
    except ValueError:
        return {"raw": resp.text[:300]}
