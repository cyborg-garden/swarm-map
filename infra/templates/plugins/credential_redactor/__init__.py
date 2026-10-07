"""credential_redactor — scrub secrets from inbound messages.

Rewrites event.text via the pre_gateway_dispatch hook BEFORE the model sees
the message and before it is persisted to state.db. Fires pre-auth, so even
unpaired senders can't land a secret in the transcript.

Scope: text/captions only — attachments are not scanned (v1).
A callback bug fails open (message passes unmodified); redaction is transcript
hygiene, not a security boundary — the vault + broker own that.

Canonical copy (Swarm Map base package v1). The fleet had 7 hand-templated
copies that differed only in a hardcoded vault link; the link is now read
from the environment so one file serves every agent:
  CREDENTIAL_VAULT_URL  explicit link shown in the notice, or
  HSM_PUBLIC_URL + HERMES_AGENT_NAME  → <HSM_PUBLIC_URL>/keys?assign=h_<name>
With neither set the notice omits the link (it still redacts).
"""

import os
import re

def _vault_link():
    explicit = os.environ.get("CREDENTIAL_VAULT_URL", "").strip()
    if explicit:
        return explicit
    base = os.environ.get("HSM_PUBLIC_URL", "").strip().rstrip("/")
    name = os.environ.get("HERMES_AGENT_NAME", "").strip()
    if base and name and re.fullmatch(r"[A-Za-z0-9_-]+", name):
        return f"{base}/keys?assign=h_{name.replace('-', '_')}"
    return ""


def _notice():
    link = _vault_link()
    where = f" Store it at {link} (operator tailnet devices only)." if link else ""
    return f"[credential redacted before the agent saw it — never paste secrets in chat.{where}]"


NOTICE = _notice()

PATTERNS = [
    # sk-ant-*, sk-proj-*, sk_hedra_*, sk_live_*/sk_test_* (Stripe), generic sk keys
    re.compile(r"\bsk[-_][A-Za-z0-9_-]{16,}"),
    # GitHub classic + fine-grained tokens
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{40,}"),
    # AWS access key id
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    # Slack tokens
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    # Notion tokens (ntn_ new style, secret_ integration style)
    re.compile(r"\bntn_[A-Za-z0-9]{20,}|\bsecret_[A-Za-z0-9]{32,}"),
    # PEM private key blocks
    re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----"),
    # Generic KEY/TOKEN/SECRET/PASSWORD = "long-value" assignments
    re.compile(r"(?i)(?:api[_-]?key|token|secret|password)\s*[=:]\s*[\"']?[A-Za-z0-9+/=_-]{20,}"),
]


def redact(text):
    """Return redacted text, or None if nothing matched."""
    if not isinstance(text, str) or not text:
        return None
    new = text
    for pat in PATTERNS:
        new = pat.sub(NOTICE, new)
    return new if new != text else None


def _on_pre_gateway_dispatch(event=None, gateway=None, session_store=None, **_):
    new = redact(getattr(event, "text", None))
    if new is not None:
        return {"action": "rewrite", "text": new}
    return None


def register(ctx):
    ctx.register_hook("pre_gateway_dispatch", _on_pre_gateway_dispatch)
