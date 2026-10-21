"""Tests for the captcha_cascade HSM plugin.

All Camofox and CapSolver interactions are mocked via requests — no
hermes-agent-mt imports needed.
"""

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# Add plugin directory to path so we can import the module directly
sys.path.insert(0, os.path.dirname(__file__))

from __init__ import (  # noqa: E402
    _extract_sitekey_js,
    _parse_sitekey_response,
    _capsolver_solve,
    _inject_token_js,
    _camofox_url,
    _vnc_url,
    _camofox_eval,
    _screenshot,
    _handle_captcha_solve,
    register,
    CAPSOLVER_TASK_TYPES,
)


# ---------------------------------------------------------------------------
# Layer 1: Sitekey extraction
# ---------------------------------------------------------------------------


class TestExtractSitekeyJS:
    """_extract_sitekey_js returns JS that finds CAPTCHA sitekeys."""

    def test_returns_string(self):
        js = _extract_sitekey_js()
        assert isinstance(js, str)
        assert len(js) > 0

    def test_js_checks_recaptcha(self):
        js = _extract_sitekey_js()
        assert "g-recaptcha" in js

    def test_js_checks_hcaptcha(self):
        js = _extract_sitekey_js()
        assert "h-captcha" in js

    def test_js_checks_turnstile(self):
        js = _extract_sitekey_js()
        assert "cf-turnstile" in js

    def test_js_checks_iframes(self):
        js = _extract_sitekey_js()
        assert "iframe" in js.lower()


class TestParseSitekeyResponse:
    """_parse_sitekey_response parses JSON eval results into (sitekey, subtype)."""

    def test_recaptcha_sitekey(self):
        raw = json.dumps({"sitekey": "6LeIxAcTAAAAAN...", "subtype": "recaptcha"})
        sitekey, subtype = _parse_sitekey_response(raw)
        assert sitekey == "6LeIxAcTAAAAAN..."
        assert subtype == "recaptcha"

    def test_hcaptcha_sitekey(self):
        raw = json.dumps({"sitekey": "abc123", "subtype": "hcaptcha"})
        sitekey, subtype = _parse_sitekey_response(raw)
        assert sitekey == "abc123"
        assert subtype == "hcaptcha"

    def test_turnstile_sitekey(self):
        raw = json.dumps({"sitekey": "0x4AAAAAAA", "subtype": "turnstile"})
        sitekey, subtype = _parse_sitekey_response(raw)
        assert sitekey == "0x4AAAAAAA"
        assert subtype == "turnstile"

    def test_no_captcha_found(self):
        raw = json.dumps({"sitekey": None, "subtype": None})
        sitekey, subtype = _parse_sitekey_response(raw)
        assert sitekey is None
        assert subtype is None

    def test_malformed_json(self):
        sitekey, subtype = _parse_sitekey_response("not json at all")
        assert sitekey is None
        assert subtype is None

    def test_empty_string(self):
        sitekey, subtype = _parse_sitekey_response("")
        assert sitekey is None
        assert subtype is None

    def test_missing_keys(self):
        raw = json.dumps({"something": "else"})
        sitekey, subtype = _parse_sitekey_response(raw)
        assert sitekey is None
        assert subtype is None


# ---------------------------------------------------------------------------
# Layer 2: CapSolver client + token injection
# ---------------------------------------------------------------------------


class TestCapsolverSolve:
    """_capsolver_solve calls CapSolver API and returns a token or None."""

    def test_successful_recaptcha_solve(self, monkeypatch):
        monkeypatch.setenv("CAPSOLVER_API_KEY", "CAP-test-key")

        responses = [
            MagicMock(
                status_code=200,
                json=lambda: {"errorId": 0, "taskId": "task-abc"},
            ),
            MagicMock(
                status_code=200,
                json=lambda: {
                    "errorId": 0,
                    "status": "ready",
                    "solution": {"gRecaptchaResponse": "solved-token-123"},
                },
            ),
        ]
        call_count = {"n": 0}

        def mock_post(url, json=None, timeout=None):
            resp = responses[call_count["n"]]
            call_count["n"] += 1
            return resp

        import __init__ as mod
        monkeypatch.setattr(mod, "requests", MagicMock(post=mock_post))
        monkeypatch.setattr(mod.time, "sleep", lambda _: None)

        token = _capsolver_solve("sitekey-123", "https://example.com", "recaptcha")
        assert token == "solved-token-123"

    def test_successful_hcaptcha_solve(self, monkeypatch):
        monkeypatch.setenv("CAPSOLVER_API_KEY", "CAP-test-key")

        responses = [
            MagicMock(json=lambda: {"errorId": 0, "taskId": "task-hc"}),
            MagicMock(json=lambda: {
                "errorId": 0, "status": "ready",
                "solution": {"gRecaptchaResponse": "hcaptcha-token"},
            }),
        ]
        call_count = {"n": 0}

        def mock_post(url, json=None, timeout=None):
            resp = responses[call_count["n"]]
            call_count["n"] += 1
            return resp

        import __init__ as mod
        monkeypatch.setattr(mod, "requests", MagicMock(post=mock_post))
        monkeypatch.setattr(mod.time, "sleep", lambda _: None)

        token = _capsolver_solve("sitekey-hc", "https://example.com", "hcaptcha")
        assert token == "hcaptcha-token"

    def test_successful_turnstile_solve(self, monkeypatch):
        monkeypatch.setenv("CAPSOLVER_API_KEY", "CAP-test-key")

        responses = [
            MagicMock(json=lambda: {"errorId": 0, "taskId": "task-ts"}),
            MagicMock(json=lambda: {
                "errorId": 0, "status": "ready",
                "solution": {"token": "turnstile-token-xyz"},
            }),
        ]
        call_count = {"n": 0}

        def mock_post(url, json=None, timeout=None):
            resp = responses[call_count["n"]]
            call_count["n"] += 1
            return resp

        import __init__ as mod
        monkeypatch.setattr(mod, "requests", MagicMock(post=mock_post))
        monkeypatch.setattr(mod.time, "sleep", lambda _: None)

        token = _capsolver_solve("sitekey-ts", "https://example.com", "turnstile")
        assert token == "turnstile-token-xyz"

    def test_no_api_key_returns_none(self, monkeypatch):
        monkeypatch.delenv("CAPSOLVER_API_KEY", raising=False)
        token = _capsolver_solve("sitekey", "https://example.com", "recaptcha")
        assert token is None

    def test_unknown_subtype_returns_none(self, monkeypatch):
        monkeypatch.setenv("CAPSOLVER_API_KEY", "CAP-test-key")
        token = _capsolver_solve("sitekey", "https://example.com", "unknown_type")
        assert token is None

    def test_api_error_returns_none(self, monkeypatch):
        monkeypatch.setenv("CAPSOLVER_API_KEY", "CAP-test-key")

        def mock_post(url, json=None, timeout=None):
            return MagicMock(json=lambda: {"errorId": 1, "errorDescription": "bad"})

        import __init__ as mod
        monkeypatch.setattr(mod, "requests", MagicMock(post=mock_post))

        token = _capsolver_solve("sitekey", "https://example.com", "recaptcha")
        assert token is None

    def test_timeout_returns_none(self, monkeypatch):
        monkeypatch.setenv("CAPSOLVER_API_KEY", "CAP-test-key")

        call_count = {"n": 0}

        def mock_post(url, json=None, timeout=None):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return MagicMock(json=lambda: {"errorId": 0, "taskId": "task-slow"})
            return MagicMock(json=lambda: {"errorId": 0, "status": "processing"})

        time_values = iter(range(0, 300, 4))

        import __init__ as mod
        monkeypatch.setattr(mod, "requests", MagicMock(post=mock_post))
        monkeypatch.setattr(mod.time, "sleep", lambda _: None)
        monkeypatch.setattr(mod.time, "time", lambda: next(time_values))

        token = _capsolver_solve("sitekey", "https://example.com", "recaptcha")
        assert token is None

    def test_network_error_returns_none(self, monkeypatch):
        monkeypatch.setenv("CAPSOLVER_API_KEY", "CAP-test-key")

        import requests as req_mod
        def mock_post(url, json=None, timeout=None):
            raise req_mod.ConnectionError("network down")

        import __init__ as mod
        monkeypatch.setattr(mod, "requests", MagicMock(post=mock_post, ConnectionError=req_mod.ConnectionError))

        token = _capsolver_solve("sitekey", "https://example.com", "recaptcha")
        assert token is None


class TestInjectTokenJS:
    """_inject_token_js returns JavaScript for injecting solved tokens."""

    def test_recaptcha_injection(self):
        js = _inject_token_js("recaptcha", "token-abc")
        assert "g-recaptcha-response" in js
        assert "token-abc" in js
        assert "___grecaptcha_cfg" in js

    def test_hcaptcha_injection(self):
        js = _inject_token_js("hcaptcha", "hc-token")
        assert "h-captcha-response" in js
        assert "hc-token" in js

    def test_turnstile_injection(self):
        js = _inject_token_js("turnstile", "ts-token")
        assert "cf-turnstile-response" in js
        assert "ts-token" in js

    def test_unknown_returns_null(self):
        js = _inject_token_js("unknown", "token")
        assert js == "null;"

    def test_token_escaping(self):
        js = _inject_token_js("recaptcha", "tok'en\\with\nnewline")
        # Should not contain raw single quotes or unescaped backslashes
        assert "tok\\'en" in js


# ---------------------------------------------------------------------------
# Camofox helpers
# ---------------------------------------------------------------------------


class TestCamofoxUrl:
    def test_returns_env_var(self, monkeypatch):
        monkeypatch.setenv("CAMOFOX_URL", "http://localhost:9377/")
        assert _camofox_url() == "http://localhost:9377"

    def test_returns_empty_when_not_set(self, monkeypatch):
        monkeypatch.delenv("CAMOFOX_URL", raising=False)
        assert _camofox_url() == ""


class TestVncUrl:
    """_vnc_url prefers the HSM-provided external URL over Camofox /health.

    HSM knows the externally-reachable VNC address (host bind + published port);
    the in-container /health only reports the internal noVNC port and the URL is
    built from CAMOFOX_URL (host.docker.internal), which is unreachable by a human.
    """

    def test_prefers_vnc_external_url_env(self, monkeypatch):
        monkeypatch.setenv("VNC_EXTERNAL_URL", "http://192.0.2.5:10642")
        monkeypatch.setenv("CAMOFOX_URL", "http://host.docker.internal:9377")
        # Must NOT hit the network when the external URL is provided
        import __init__ as mod
        monkeypatch.setattr(
            mod, "requests",
            MagicMock(get=MagicMock(side_effect=AssertionError("should not call /health"))),
        )
        assert _vnc_url() == "http://192.0.2.5:10642"

    def test_strips_trailing_slash_on_external_url(self, monkeypatch):
        monkeypatch.setenv("VNC_EXTERNAL_URL", "http://192.0.2.5:10642/")
        assert _vnc_url() == "http://192.0.2.5:10642"

    def test_falls_back_to_health_when_no_external_url(self, monkeypatch):
        monkeypatch.delenv("VNC_EXTERNAL_URL", raising=False)
        monkeypatch.setenv("CAMOFOX_URL", "http://camofox.local:9377")
        health = MagicMock(status_code=200)
        health.json.return_value = {"vncPort": 6080}
        import __init__ as mod
        monkeypatch.setattr(mod, "requests", MagicMock(get=MagicMock(return_value=health)))
        assert _vnc_url() == "http://camofox.local:6080"

    def test_returns_none_when_nothing_configured(self, monkeypatch):
        monkeypatch.delenv("VNC_EXTERNAL_URL", raising=False)
        monkeypatch.delenv("CAMOFOX_URL", raising=False)
        assert _vnc_url() is None


class TestCamofoxEval:
    def test_successful_eval(self, monkeypatch):
        monkeypatch.setenv("CAMOFOX_URL", "http://localhost:9377")

        tabs_resp = MagicMock(status_code=200)
        tabs_resp.json.return_value = [{"tabId": "t1", "userId": "u1"}]

        eval_resp = MagicMock(status_code=200)
        eval_resp.json.return_value = {"result": "42"}
        eval_resp.raise_for_status = MagicMock()

        import __init__ as mod
        mock_requests = MagicMock()
        mock_requests.get.return_value = tabs_resp
        mock_requests.post.return_value = eval_resp
        monkeypatch.setattr(mod, "requests", mock_requests)

        result = _camofox_eval("1+1", "task-1")
        assert result["success"] is True
        assert result["result"] == 42  # JSON-parsed from string "42"

    def test_no_camofox_url(self, monkeypatch):
        monkeypatch.delenv("CAMOFOX_URL", raising=False)
        result = _camofox_eval("1+1")
        assert result["success"] is False

    def test_no_tabs(self, monkeypatch):
        monkeypatch.setenv("CAMOFOX_URL", "http://localhost:9377")

        tabs_resp = MagicMock(status_code=200)
        tabs_resp.json.return_value = []

        import __init__ as mod
        mock_requests = MagicMock()
        mock_requests.get.return_value = tabs_resp
        monkeypatch.setattr(mod, "requests", mock_requests)

        result = _camofox_eval("1+1")
        assert result["success"] is False

    def test_eval_404(self, monkeypatch):
        monkeypatch.setenv("CAMOFOX_URL", "http://localhost:9377")

        tabs_resp = MagicMock(status_code=200)
        tabs_resp.json.return_value = [{"tabId": "t1", "userId": "u1"}]

        eval_resp = MagicMock(status_code=404)
        eval_resp.raise_for_status = MagicMock()

        import __init__ as mod
        mock_requests = MagicMock()
        mock_requests.get.return_value = tabs_resp
        mock_requests.post.return_value = eval_resp
        monkeypatch.setattr(mod, "requests", mock_requests)

        result = _camofox_eval("1+1")
        assert result["success"] is False
        assert "not supported" in result.get("error", "").lower()


# ---------------------------------------------------------------------------
# Tool handler
# ---------------------------------------------------------------------------


class TestHandleCaptchaSolve:
    def test_no_camofox_returns_error(self, monkeypatch):
        monkeypatch.delenv("CAMOFOX_URL", raising=False)
        result = json.loads(_handle_captcha_solve("task-1"))
        assert result["success"] is False
        assert "Camofox not configured" in result["error"]

    def test_eval_failure_escalates(self, monkeypatch):
        monkeypatch.setenv("CAMOFOX_URL", "http://localhost:9377")

        import __init__ as mod
        monkeypatch.setattr(mod, "_camofox_eval", lambda expr, tid: {"success": False, "error": "fail"})
        monkeypatch.setattr(mod, "_vnc_url", lambda: "http://host:5900")
        monkeypatch.setattr(mod, "_screenshot", lambda: "base64data")

        result = json.loads(_handle_captcha_solve("task-1"))
        assert result["success"] is False
        assert "captcha_escalation" in result
        assert result["captcha_escalation"]["vnc_url"] == "http://host:5900"

    def test_no_sitekey_escalates(self, monkeypatch):
        monkeypatch.setenv("CAMOFOX_URL", "http://localhost:9377")

        import __init__ as mod
        monkeypatch.setattr(mod, "_camofox_eval", lambda expr, tid: {
            "success": True,
            "result": {"sitekey": None, "subtype": None},
        })
        monkeypatch.setattr(mod, "_vnc_url", lambda: None)
        monkeypatch.setattr(mod, "_screenshot", lambda: "")

        result = json.loads(_handle_captcha_solve("task-1"))
        assert result["success"] is False
        assert "captcha_escalation" in result

    def test_capsolver_success(self, monkeypatch):
        monkeypatch.setenv("CAMOFOX_URL", "http://localhost:9377")
        monkeypatch.setenv("CAPSOLVER_API_KEY", "CAP-key")

        eval_calls = []

        def mock_eval(expr, tid):
            eval_calls.append(expr)
            if len(eval_calls) == 1:
                return {"success": True, "result": {"sitekey": "sk-1", "subtype": "recaptcha"}}
            return {"success": True, "result": "injected"}

        import __init__ as mod

        # Mock tabs request for page URL extraction
        tabs_resp = MagicMock(status_code=200)
        tabs_resp.json.return_value = [{"url": "https://example.com"}]
        mock_requests = MagicMock()
        mock_requests.get.return_value = tabs_resp
        monkeypatch.setattr(mod, "requests", mock_requests)
        monkeypatch.setattr(mod, "_camofox_eval", mock_eval)
        monkeypatch.setattr(mod, "_capsolver_solve", lambda sk, url, st: "solved-token")
        monkeypatch.setattr(mod.time, "sleep", lambda _: None)

        result = json.loads(_handle_captcha_solve("task-1"))
        assert result["success"] is True
        assert result["captcha_solved"] is True
        assert result["method"] == "capsolver"

    def test_capsolver_fail_escalates(self, monkeypatch):
        monkeypatch.setenv("CAMOFOX_URL", "http://localhost:9377")
        monkeypatch.setenv("CAPSOLVER_API_KEY", "CAP-key")

        import __init__ as mod

        monkeypatch.setattr(mod, "_camofox_eval", lambda expr, tid: {
            "success": True, "result": {"sitekey": "sk-1", "subtype": "hcaptcha"},
        })

        tabs_resp = MagicMock(status_code=200)
        tabs_resp.json.return_value = [{"url": "https://example.com"}]
        mock_requests = MagicMock()
        mock_requests.get.return_value = tabs_resp
        monkeypatch.setattr(mod, "requests", mock_requests)
        monkeypatch.setattr(mod, "_capsolver_solve", lambda sk, url, st: None)
        monkeypatch.setattr(mod, "_vnc_url", lambda: "http://host:5900")
        monkeypatch.setattr(mod, "_screenshot", lambda: "")

        result = json.loads(_handle_captcha_solve("task-1"))
        assert result["success"] is False
        assert "captcha_escalation" in result
        assert "failed" in result["captcha_escalation"]["hint"]


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


class TestRegister:
    def test_registers_tool(self, monkeypatch):
        monkeypatch.setenv("CAMOFOX_URL", "http://localhost:9377")

        ctx = MagicMock()
        register(ctx)
        ctx.register_tool.assert_called_once()
        call_kwargs = ctx.register_tool.call_args
        assert call_kwargs[1]["name"] == "captcha_solve" or call_kwargs.kwargs.get("name") == "captcha_solve"

    def test_registers_without_camofox(self, monkeypatch):
        monkeypatch.delenv("CAMOFOX_URL", raising=False)
        ctx = MagicMock()
        register(ctx)
        # Still registers — tool checks at call time
        ctx.register_tool.assert_called_once()

    def test_skips_when_no_requests(self, monkeypatch):
        import __init__ as mod
        original = mod.requests
        monkeypatch.setattr(mod, "requests", None)
        ctx = MagicMock()
        register(ctx)
        ctx.register_tool.assert_not_called()
        monkeypatch.setattr(mod, "requests", original)
