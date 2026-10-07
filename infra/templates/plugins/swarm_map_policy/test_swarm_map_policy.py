"""Public browser guard tests. Network is mocked: getaddrinfo is patched."""
import importlib.util
import os
import socket
import sys

import pytest

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("swarm_map_policy", os.path.join(_here, "__init__.py"))
policy = importlib.util.module_from_spec(_spec)
sys.modules["swarm_map_policy"] = policy
_spec.loader.exec_module(policy)


# A globally routable address (IPv6, so the sanitization IPv4 rule stays quiet).
PUBLIC_ADDR = "2606:4700:4700::1111"


def _resolve_to(monkeypatch, addr):
    fam = socket.AF_INET6 if ":" in addr else socket.AF_INET
    monkeypatch.setattr(policy.socket, "getaddrinfo", lambda *a, **k: [(fam, 1, 6, "", (addr, 0))])


@pytest.fixture
def public(monkeypatch):
    monkeypatch.setenv("SWARM_MAP_SURFACE", "public")


def call(tool, **args):
    return policy._pre_tool_call(tool_name=tool, args=args)


class TestPublicSurface:
    def test_public_site_allowed(self, public, monkeypatch):
        _resolve_to(monkeypatch, PUBLIC_ADDR)
        assert call("browser_navigate", url="https://example.com/") is None

    @pytest.mark.parametrize("addr", ["127.0.0.1", "10.0.0.5", "192.168.0.10", "172.17.0.1",
                                      "100.101.102.103", "169.254.169.254", "::1", "fd00::1",
                                      "::ffff:192.168.1.1"])
    def test_private_addresses_blocked(self, public, monkeypatch, addr):
        _resolve_to(monkeypatch, addr)
        r = call("browser_navigate", url="http://looks-public.example/")
        assert r and r["action"] == "block"

    @pytest.mark.parametrize("url", ["http://host.docker.internal:3000/api", "http://localhost:9377",
                                     "http://router.lan/", "file:///etc/passwd", "javascript:alert(1)", ""])
    def test_internal_names_and_schemes_blocked(self, public, monkeypatch, url):
        _resolve_to(monkeypatch, PUBLIC_ADDR)  # even if it "resolved" public
        assert call("browser_navigate", url=url)["action"] == "block"

    def test_dns_failure_blocks(self, public, monkeypatch):
        def boom(*a, **k):
            raise socket.gaierror("nope")
        monkeypatch.setattr(policy.socket, "getaddrinfo", boom)
        assert call("browser_navigate", url="https://nx.example/")["action"] == "block"

    def test_cdp_blocked_and_js_eval_blocked(self, public):
        assert call("browser_cdp", method="Runtime.evaluate")["action"] == "block"
        assert call("browser_console", expression="fetch('http://10.0.0.1')")["action"] == "block"

    def test_reading_the_page_allowed(self, public):
        assert call("browser_console") is None
        assert call("browser_snapshot") is None
        assert call("browser_click", ref="@e1") is None
        assert call("web_search", query="x") is None


class TestNonPublic:
    def test_no_guard_off_public(self, monkeypatch):
        monkeypatch.setenv("SWARM_MAP_SURFACE", "team")
        assert call("browser_navigate", url="http://192.168.1.1/") is None
        assert call("browser_cdp", method="x") is None

    def test_admin_gate_unchanged(self, public):
        policy.clear_session_context()
        assert call("approval")["action"] == "block"
