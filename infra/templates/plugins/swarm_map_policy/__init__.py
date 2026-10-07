"""Swarm Map Policy Plugin — HSM-backed group access control.

Integrates with Swarm Map (formerly HSM) to enforce:
- Group allowlists: only groups registered in HSM can interact
- Admin checks: platform admin status from HSM settings
- Session context caching: platform/chat_id/user_id/is_admin from gateway events
- Approval gating: admin-only tool restrictions
- Public browser guard: on a public surface (SWARM_MAP_SURFACE=public) the
  browser stays on, but navigation to private/internal addresses, page
  JavaScript evaluation and raw CDP are blocked

Configuration via environment variables:
- HSM_URL: URL of the HSM API (e.g., http://localhost:3002)
- HERMES_AGENT_NAME: Agent identifier in HSM (e.g., hermes-researcher)
- SWARM_MAP_SURFACE: base-package surface (private | team | public)

Security model:
- Group checks: FAIL-CLOSED (deny if HSM unreachable)
- Admin checks: FAIL-CLOSED (deny if HSM unreachable)
- Approval gating: FAIL-CLOSED (deny if no session context)
- Tool checks: FAIL-OPEN (allow if not configured)
- Public browser guard: FAIL-CLOSED (unresolvable host = blocked)
"""

import ipaddress
import logging
import os
import socket
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

# Public surface: browser tools that are never allowed (raw Chrome DevTools).
PUBLIC_BLOCKED_TOOLS = {"browser_cdp"}
# Hostnames that reach the host or the container network whatever they resolve to.
_INTERNAL_HOSTNAMES = {"localhost", "host.docker.internal", "gateway.docker.internal", "metadata.google.internal"}
_INTERNAL_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home.arpa", ".ts.net")


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


def _is_public_surface() -> bool:
    return os.environ.get("SWARM_MAP_SURFACE", "").strip().lower() == "public"


def is_public_url(url: str) -> bool:
    """True only for an http(s) URL whose host resolves to public addresses only.

    Fail-closed: a bad scheme, an internal-looking hostname, a DNS failure, or
    ANY resolved address that is not globally routable (private, loopback,
    link-local, CGNAT/Tailscale, reserved) means False. Hermes skips its own
    SSRF check for the camofox backend (it treats camofox as local), and the
    camofox container can reach the host and the LAN, so a public bot needs
    this gate in front of navigation.
    """
    try:
        from urllib.parse import urlparse
        parsed = urlparse(str(url or "").strip())
        if parsed.scheme.lower() not in ("http", "https"):
            return False
        host = (parsed.hostname or "").strip().lower().rstrip(".")
        if not host or host in _INTERNAL_HOSTNAMES or host.endswith(_INTERNAL_SUFFIXES):
            return False
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme.lower() == "https" else 80))
        if not infos:
            return False
        for info in infos:
            ip = ipaddress.ip_address(info[4][0].split("%", 1)[0])
            mapped = getattr(ip, "ipv4_mapped", None)
            if mapped is not None:
                ip = mapped
            if not ip.is_global or ip.is_multicast:
                return False
        return True
    except Exception:
        return False


def public_browser_block(tool_name: str, args: Optional[dict]) -> Optional[dict]:
    """The public-surface browser policy. None = allow, dict = block."""
    if not tool_name or not tool_name.startswith("browser_"):
        return None
    args = args if isinstance(args, dict) else {}
    if tool_name in PUBLIC_BLOCKED_TOOLS:
        return {"action": "block", "message": f"{tool_name} is not available on a public agent."}
    if tool_name == "browser_console" and str(args.get("expression") or "").strip():
        return {
            "action": "block",
            "message": "Running JavaScript in the page is not available on a public agent; "
                       "use browser_snapshot to read the page.",
        }
    if tool_name == "browser_navigate" and not is_public_url(args.get("url", "")):
        return {
            "action": "block",
            "message": "Blocked: a public agent can only open public http(s) websites, "
                       "not private, internal or local addresses.",
        }
    return None


def _pre_tool_call(tool_name: str = None, args: dict = None, **kwargs):
    """Gate tool calls based on HSM policy. Returns None to allow, dict to block."""
    if _is_public_surface():
        blocked = public_browser_block(tool_name, args)
        if blocked:
            logger.info("swarm-map-policy: public surface blocked %s", tool_name)
            return blocked
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
    # The tool gate needs no network, so it registers even without requests
    # (the public browser guard must never silently drop out).
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    if not requests:
        logger.warning("swarm-map-policy: 'requests' not installed, HSM checks disabled")
        return
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_gateway_dispatch", _pre_gateway_dispatch)
    logger.info(
        "swarm-map-policy: registered (HSM_URL=%s, public browser guard %s)",
        _hsm_url() or "not set", "on" if _is_public_surface() else "off",
    )
