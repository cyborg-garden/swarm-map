"""Property-based discovery suite for layer 1 of the sanitization gate.

Not part of the gate's CI self-tests (the workflow runs only
test_check_sanitization.py and does not install hypothesis). Run it by hand:

    python -m venv .venv && .venv/bin/pip install hypothesis pytest
    .venv/bin/python -m pytest scripts/test_sanitization_properties.py -q
    HYPOTHESIS_PROFILE=deep .venv/bin/python -m pytest scripts/test_sanitization_properties.py -q

Method: generate synthetic credential/PII shapes, plant each inside a wrapping
an honest committer could produce by accident (JSON, YAML, URLs, non-English
prose, CRLF, UTF-16/32, BOMs, latin-1, NUL-prefixed binaries, large files, odd
file names), write it to a real file and run the gate's ``main()`` on it.
Properties:
  * clean filler alone passes;
  * filler + a planted secret fails with exit 1.

Every fixture is assembled from fragments at run time and every body is random,
so this file holds no literal sample of anything the gate detects (it is
scanned by the gate itself). No network, no semantic layer.
"""
import contextlib
import io
import json
import os
import shutil
import string
import subprocess
import sys
import tempfile

import pytest

hyp = pytest.importorskip("hypothesis")
from hypothesis import HealthCheck, given, settings  # noqa: E402
from hypothesis import strategies as st  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_sanitization as cs  # noqa: E402

settings.register_profile("default", max_examples=300, deadline=None,
                          suppress_health_check=[HealthCheck.too_slow])
settings.register_profile("deep", max_examples=3000, deadline=None,
                          suppress_health_check=[HealthCheck.too_slow])
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "default"))

# ---------------------------------------------------------------- bodies

ALNUM = string.ascii_letters + string.digits
UPPER_DIGIT = string.ascii_uppercase + string.digits
HEX = "0123456789abcdef"
_PLACEHOLDERISH = ("your", "example", "change", "placeholder", "replace", "redacted",
                   "dummy", "sample", "insert", "todo", "xxxx")


def _realistic(s):
    low = s.lower()
    return (len(set(s)) > 4 and any(c.isdigit() for c in s) and any(c.isalpha() for c in s)
            and not any(w in low for w in _PLACEHOLDERISH))


def body(alphabet, n):
    return st.text(alphabet, min_size=n, max_size=n).filter(_realistic)


def j(*parts):
    return "".join(parts)


# (family, strategy) — each value is something the gate must report.
def _private_key_header(kind):
    tail = " BLOCK" if kind == "PGP " else ""
    return j("-----BEGIN ", kind, "PRIVATE", " KEY", tail, "-----")


SECRETS = {
    "anthropic": body(ALNUM, 48).map(lambda b: j("sk", "-ant-", "api03-", b)),
    "openai-proj": body(ALNUM, 48).map(lambda b: j("sk", "-proj-", b)),
    "github": st.tuples(st.sampled_from("pousr"), body(ALNUM, 36)).map(
        lambda t: j("gh", t[0], "_", t[1])),
    "github-pat": body(ALNUM, 70).map(lambda b: j("github", "_pat_", "11", b)),
    "aws": body(UPPER_DIGIT, 16).map(lambda b: j("AK", "IA", b)),
    "google": body(ALNUM, 35).map(lambda b: j("AI", "za", b)),
    "slack": body(ALNUM, 24).map(lambda b: j("xo", "xb-", "1234567890", "-", b)),
    "stripe": body(ALNUM, 24).map(lambda b: j("sk", "_live_", b)),
    "huggingface": body(ALNUM, 34).map(lambda b: j("hf", "_", b)),
    "npm": body(ALNUM, 36).map(lambda b: j("npm", "_", b)),
    "gitlab": body(ALNUM, 20).map(lambda b: j("glpat", "-", b)),
    "notion": body(ALNUM, 40).map(lambda b: j("ntn", "_", b)),
    "openrouter": body(HEX, 64).map(lambda b: j("sk", "-or-v1-", b)),
    "telegram": st.tuples(st.integers(10**8, 10**9 - 1), body(ALNUM, 35)).map(
        lambda t: j(str(t[0]), ":", t[1])),
    "private-key": st.sampled_from(["", "RSA ", "EC ", "OPENSSH ", "DSA ", "ENCRYPTED ", "PGP "]).map(
        _private_key_header),
    "jwt": st.tuples(body(ALNUM, 20), body(ALNUM, 30), body(ALNUM, 20)).map(
        lambda t: j("ey", "J", t[0], ".", "ey", "J", t[1], ".", t[2])),
    "email": st.tuples(st.text(string.ascii_lowercase, min_size=3, max_size=10),
                       st.text(string.ascii_lowercase, min_size=3, max_size=10),
                       st.sampled_from(["io", "co", "org", "nz", "dev"])).map(
        lambda t: j(t[0], ".", "q", "@", t[1], "corp.", t[2])),
    "conn-string": st.tuples(st.sampled_from(["postgres", "mysql", "redis", "amqp", "mongodb"]),
                             st.sampled_from(["svc", "admin", "app", ""]),
                             body(ALNUM, 18)).map(
        lambda t: j(t[0], ":", "//", t[1], ":", t[2], "@", "db.internal:5432/x")),
    "assignment": st.tuples(
        st.sampled_from(["password", "api_key", "client_secret", "DB_PASSWORD", "AUTH_TOKEN",
                         "SECRET_KEY", "aws_secret_access_key", "API_KEY_PROD"]),
        st.sampled_from([" = ", "=", ": ", " := ", " => "]),
        st.sampled_from(['"', "'"]),
        body(ALNUM + "/+_-", 32)).map(lambda t: j(t[0], t[1], t[2], t[3], t[2])),
    "assignment-symbols": st.tuples(
        st.sampled_from(["password", "DB_PASSWORD"]),
        st.text("!#%&*?^~", min_size=1, max_size=3),
        body(ALNUM, 16)).map(lambda t: j(t[0], ' = "', t[2][:8], t[1], t[2][8:], '"')),
}
FAMILIES = sorted(SECRETS)

# ---------------------------------------------------------------- wrappings

WORDS = ["the", "agent", "reads", "config", "before", "starting", "kia", "ora", "whānau",
         "café", "naïve", "über", "notes", "deploy", "runbook", "日本語", "設定", "Привет"]
filler = st.lists(st.sampled_from(WORDS), min_size=0, max_size=30).map(" ".join)


def _json_nl(s):
    return json.dumps({"env": j("A=1\n", s, "\nB=2")})


WRAPS = {
    "plain": lambda s: j("note ", s, " end"),
    "alone-line": lambda s: j("\n", s, "\n"),
    "backticks": lambda s: j("use `", s, "` here"),
    "json": lambda s: json.dumps({"k": s}),
    "json-indented": lambda s: json.dumps({"a": {"b": [s]}}, indent=2),
    "json-escaped-newline": _json_nl,
    "json-escaped-slash": lambda s: json.dumps({"k": s}).replace("/", "\\/"),
    "yaml-dq": lambda s: j('value: "', s, '"'),
    "yaml-sq": lambda s: j("value: '", s, "'"),
    "yaml-plain": lambda s: j("value: ", s),
    "shell": lambda s: j("export THING='", s, "'"),
    "dockerfile": lambda s: j("ENV THING=", s),
    "xml": lambda s: j("<v>", s, "</v>"),
    "html-attr": lambda s: j('<a data-v="', s, '">x</a>'),
    "comment-hash": lambda s: j("# ", s),
    "comment-slash": lambda s: j("// ", s),
    "url-query": lambda s: j("https://h.invalid/cb?v=", s, "&n=1"),
    "url-path": lambda s: j("https://h.invalid/a/", s, "/b"),
    "cjk-prose": lambda s: j("鍵は", s, "です"),
    "cyrillic-prose": lambda s: j("ключ", s, "тут"),
    "tab": lambda s: j("\t", s, "\t"),
}
WRAP_NAMES = sorted(WRAPS)
# Wrappings a family can never meaningfully sit in (not gate bugs).
_NO_WRAP = {
    # A URL inside a URL path/query is no longer the same URL; a bare email as a
    # path segment is not an address.
    "conn-string": {"url-path", "url-query"},
    "email": {"url-path"},
    # An assignment is a line of code, not a value inside another value.
    "assignment": {"url-path", "url-query", "json-escaped-slash", "cjk-prose", "cyrillic-prose"},
    "assignment-symbols": {"url-path", "url-query", "json-escaped-slash", "cjk-prose",
                           "cyrillic-prose"},
}


def wrap_ok(family, wrap):
    return wrap not in _NO_WRAP.get(family, set())


ENCODINGS = ["utf-8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "utf-32", "cp1252"]


def encode(text, enc):
    if enc == "cp1252":
        return text.encode("cp1252", errors="replace")
    return text.encode(enc)


# ---------------------------------------------------------------- harness

def run_gate(files, cfg=None):
    """Write ``files`` ({relpath: bytes}) into a fresh repo dir, run main()."""
    root = tempfile.mkdtemp(prefix="sanprop-")
    try:
        with open(os.path.join(root, cs.CONFIG_NAME), "w", encoding="utf-8") as fh:
            json.dump(cfg or {"sensitive_prefixes": ["docs/"], "deterministic": {}}, fh)
        for rel, data in files.items():
            path = os.path.join(root, rel)
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as fh:
                    fh.write(data)
            except OSError:
                hyp.reject()  # the filesystem refused the name; not a gate case
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cs.main([*files, "--deterministic-only"], root=root)
        return rc, out.getvalue()
    finally:
        shutil.rmtree(root, ignore_errors=True)


@st.composite
def planted(draw):
    family = draw(st.sampled_from(FAMILIES))
    secret = draw(SECRETS[family])
    wrap = draw(st.sampled_from([w for w in WRAP_NAMES if wrap_ok(family, w)]))
    before, after = draw(filler), draw(filler)
    crlf = draw(st.booleans())
    text = j(before, "\n", WRAPS[wrap](secret), "\n", after, "\n")
    if crlf:
        text = text.replace("\n", "\r\n")
    return family, wrap, crlf, text


# Assigned letters, combining marks, digits, punctuation, symbols and spaces up
# to the CJK planes: what a real file name can hold and the filesystem accepts.
name_part = st.text(st.characters(categories=("L", "M", "N", "P", "S", "Zs"), max_codepoint=0x2FFFF,
                                  exclude_characters="/\\\0"),
                    min_size=1, max_size=12).filter(
    lambda s: s not in (".", "..") and not s.startswith("-") and s.strip() == s and s)
rel_names = st.lists(name_part, min_size=1, max_size=3).map("/".join).filter(
    lambda p: len(p.encode("utf-8")) < 200 and p != cs.CONFIG_NAME)


def _fs_ok(rel):
    try:
        os.fsencode(rel)
    except UnicodeError:
        return False
    return True


# ---------------------------------------------------------------- properties

@given(filler, st.sampled_from(ENCODINGS), st.booleans())
def test_clean_filler_passes(text, enc, crlf):
    if crlf:
        text = text.replace(" ", "\r\n")
    rc, out = run_gate({"notes.txt": encode(text, enc)})
    assert rc == 0, out


@given(planted())
def test_planted_secret_caught_utf8(case):
    family, wrap, crlf, text = case
    rc, out = run_gate({"notes.txt": text.encode("utf-8")})
    assert rc == 1, (family, wrap, crlf, out)


@given(planted(), st.sampled_from(ENCODINGS))
def test_planted_secret_caught_any_encoding(case, enc):
    family, wrap, crlf, text = case
    if enc == "cp1252":
        # cp1252 cannot carry CJK filler; that is the editor's problem, not a leak.
        text = text.encode("cp1252", errors="ignore").decode("cp1252")
    rc, out = run_gate({"notes.txt": encode(text, enc)})
    assert rc == 1, (family, wrap, enc, out)


@given(st.sampled_from(FAMILIES).flatmap(lambda f: SECRETS[f]),
       st.sampled_from([b"\xff\xfe", b"\xfe\xff", b"\xef\xbb\xbf", b"\x00\x01\x02\x00",
                        b"\x89PNG\r\n\x1a\n\x00\x00"]),
       st.integers(0, 20000))
def test_secret_behind_stray_prefix_or_padding(secret, prefix, pad):
    data = prefix + b"a" * pad + b"\n" + secret.encode("ascii") + b"\n"
    rc, out = run_gate({"blob.bin": data})
    assert rc == 1, (prefix, pad, out)


@given(rel_names, st.sampled_from(FAMILIES).flatmap(lambda f: SECRETS[f]))
def test_odd_file_names_are_scanned(rel, secret):
    hyp.assume(_fs_ok(rel))
    rc, out = run_gate({rel: j("x ", secret, "\n").encode("utf-8")})
    assert rc == 1, out


@settings(max_examples=25, suppress_health_check=[HealthCheck.filter_too_much, HealthCheck.too_slow])
@given(st.lists(rel_names, min_size=1, max_size=3, unique_by=lambda p: p.lower()),
       st.sampled_from(FAMILIES).flatmap(lambda f: SECRETS[f]))
def test_diff_mode_sees_odd_file_names(rels, secret):
    """--diff via real git: non-ASCII and spaced names must reach the scanner."""
    hyp.assume(all(_fs_ok(r) for r in rels))
    # A path must not be both a file and a parent dir of another file.
    hyp.assume(not any(a != b and b.startswith(a + "/") for a in rels for b in rels))
    root = tempfile.mkdtemp(prefix="sanprop-git-")
    try:
        g = lambda *a: subprocess.run(["git", "-C", root, *a], check=True,  # noqa: E731
                                      capture_output=True)
        g("init", "-q", "-b", "main")
        g("config", "user.email", "t@t.invalid")
        g("config", "user.name", "t")
        g("config", "core.precomposeunicode", "true")
        with open(os.path.join(root, cs.CONFIG_NAME), "w") as fh:
            json.dump({"sensitive_prefixes": ["docs/"], "deterministic": {}}, fh)
        g("add", "-A")
        g("commit", "-qm", "base")
        g("branch", "base")
        for i, rel in enumerate(rels):
            path = os.path.join(root, rel)
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as fh:
                    fh.write((j("ok\n", secret, "\n") if i == len(rels) - 1 else "ok\n").encode())
            except OSError:
                hyp.reject()
        g("add", "-A")
        g("commit", "-qm", "change")
        os.environ["SANITIZE_BASE_REF"] = "base"
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cs.main(["--diff", "--deterministic-only"], root=root)
        assert rc == 1, out.getvalue()
    finally:
        os.environ.pop("SANITIZE_BASE_REF", None)
        shutil.rmtree(root, ignore_errors=True)


@settings(max_examples=5)
@given(st.sampled_from(FAMILIES).flatmap(lambda f: SECRETS[f]), st.sampled_from(ENCODINGS[:5]))
def test_secret_deep_in_large_file(secret, enc):
    text = j(("lorem ipsum dolor sit amet\n" * 80000), secret, "\n", "tail\n" * 1000)
    rc, out = run_gate({"big.log": encode(text, enc)})
    assert rc == 1, (enc, out[-500:])


@given(st.sampled_from(FAMILIES).flatmap(lambda f: SECRETS[f]),
       st.sampled_from(["node_modules/x/", "docs/", "a/tests_old/", "vendor/fixtures2/"]))
def test_skip_paths_only_cover_named_paths(secret, prefix):
    """A config skipping tests/ must not skip look-alike paths."""
    cfg = {"sensitive_prefixes": ["docs/"], "deterministic": {"skip_paths": ["tests/"]}}
    rc, out = run_gate({j(prefix, "f.txt"): j(secret, "\n").encode()}, cfg)
    assert rc == 1, out


@given(st.sampled_from(["anthropic", "github", "aws", "private-key", "npm", "telegram"]), st.data())
def test_high_confidence_reported_inside_skip_path(fam, data):
    secret = data.draw(SECRETS[fam])
    cfg = {"sensitive_prefixes": ["docs/"], "deterministic": {"skip_paths": ["tests/"]}}
    rc, out = run_gate({"tests/fixture.txt": j(secret, "\n").encode()}, cfg)
    assert rc == 1, out
