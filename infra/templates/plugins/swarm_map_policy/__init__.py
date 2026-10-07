"""Swarm Map Policy Plugin — HSM-backed group access control.

Integrates with Swarm Map (formerly HSM) to enforce:
- Group allowlists: only groups registered in HSM can interact
- Admin checks: platform admin status from HSM settings
- Session context caching: platform/chat_id/user_id/is_admin from gateway events
- Approval gating: admin-only tool restrictions

Configuration via environment variables:
- HSM_URL: URL of the HSM API (e.g., http://localhost:3002)
- HERMES_AGENT_NAME: Agent identifier in HSM (e.g., hermes-researcher)

Security model:
- Group checks: FAIL-CLOSED (deny if HSM unreachable)
- Admin checks: FAIL-CLOSED (deny if HSM unreachable)
- Approval gating: FAIL-CLOSED (deny if no session context)
- Tool checks: FAIL-OPEN (allow if not configured)
"""

import logging
import os
import threading
from typing import Optional

logger = logging.getLogger(__name__)

try:
    import requests
except ImportError:
    requests = None

# Thread-local storage for session context (plugin hooks are synchronous)
_session_ctx = threading.local()

# Tools that require admin privileges
ADMIN_GATED_TOOLS = {"approval", "pr_approval"}


def _hsm_url() -> Optional[str]:
    """Get HSM API URL from environment."""
    return os.environ.get("HSM_URL") or None


def _harness_id() -> Optional[str]:
    """Get this agent's harness ID from environment."""
    return os.environ.get("HERMES_AGENT_NAME") or None


def get_session_context() -> Optional[dict]:
    """Get cached session context dict, or None if not set."""
    if not hasattr(_session_ctx, "platform"):
        return None
    return {
        "platform": _session_ctx.platform,
        "chat_id": _session_ctx.chat_id,
        "user_id": _session_ctx.user_id,
        "is_admin": getattr(_session_ctx, "is_admin", False),
    }


def clear_session_context() -> None:
    """Clear cached session context."""
    for attr in ("platform", "chat_id", "user_id", "is_admin"):
        if hasattr(_session_ctx, attr):
            delattr(_session_ctx, attr)


def is_group_allowed(group_id: str, platform: str) -> bool:
    """Check if a group is in the HSM allowlist. Fail-closed."""
    url = _hsm_url()
    harness = _harness_id()
    if not url or not harness:
        logger.warning("swarm-map-policy: HSM not configured, denying group")
        return False
    try:
        resp = requests.get(
            f"{url}/api/harnesses/{harness}/surfaces/{platform}/groups/{group_id}",
            timeout=5,
        )
        return resp.status_code == 200 and resp.json().get("allowed", False)
    except Exception as e:
        logger.warning("swarm-map-policy: HSM check failed (fail-closed): %s", e)
        return False


def is_tool_allowed(tool_name: str, group_id: str) -> bool:
    """Check if a tool is allowed for a group. Fail-open."""
    url = _hsm_url()
    if not url:
        return True
    return True  # Future: check HSM tool gating API


def is_platform_admin(user_id: str, platform: str) -> bool:
    """Check if a user is a platform admin via HSM. Fail-closed."""
    url = _hsm_url()
    harness = _harness_id()
    if not url or not harness:
        return False
    try:
        resp = requests.get(
            f"{url}/api/harnesses/{harness}/surfaces/{platform}/admins/{user_id}",
            timeout=5,
        )
        return resp.status_code == 200 and resp.json().get("is_admin", False)
    except Exception:
        return False


def _pre_gateway_dispatch(event=None, **kwargs):
    """Cache session context from incoming message event and resolve admin status."""
    if event is None:
        return None
    source = event.source
    _session_ctx.platform = source.platform.value if source.platform else ""
    _session_ctx.chat_id = source.chat_id or ""
    _session_ctx.user_id = source.user_id or ""
    # Resolve admin status from HSM (fail-closed)
    _session_ctx.is_admin = False
    try:
        user_id = _session_ctx.user_id
        platform = _session_ctx.platform
        if user_id and platform:
            _session_ctx.is_admin = is_platform_admin(user_id, platform)
    except Exception as e:
        logger.warning("swarm-map-policy: admin resolution failed (fail-closed): %s", e)
        _session_ctx.is_admin = False
    return None  # Allow normal dispatch


def _on_session_start(session_id: str = None, **kwargs) -> None:
    """Log session start."""
    logger.debug("swarm-map-policy: session start %s", session_id)


def _pre_tool_call(tool_name: str = None, **kwargs):
    """Gate tool calls based on HSM policy. Returns None to allow, dict to block."""
    if tool_name in ADMIN_GATED_TOOLS:
        ctx = get_session_context()
        if not ctx or not ctx.get("is_admin"):
            return {
                "action": "block",
                "message": "Admin privileges required for approval commands.",
            }
    return None


def register(ctx):
    """Register plugin hooks."""
    if not requests:
        logger.warning("swarm-map-policy: 'requests' not installed, plugin disabled")
        return
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("pre_gateway_dispatch", _pre_gateway_dispatch)
    logger.info("swarm-map-policy: registered (HSM_URL=%s)", _hsm_url() or "not set")
