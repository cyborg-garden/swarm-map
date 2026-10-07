"""Self-check: python3 test_redactor.py (exit 0 = pass).

Every sample secret is assembled from fragments at runtime so this file never
contains a string that a secret scanner would flag.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from __init__ import redact  # noqa: E402

A = "A1b2C3d4E5f6G7h8J9k0"  # 20 chars of filler


def j(*parts):
    return "".join(parts)


REDACTED = [
    j("here you go sk", "_hedra_", A, A),
    j("use sk", "_live_", A),
    j("key: sk", "-ant-", A, A),
    j("sk", "-proj-", A),
    j("gh", "p_", A, A),
    j("github", "_pat_", "A1_" * 20),
    j("AK", "IA", "ABCDEFGHIJKLMNOP", " is the id"),
    j("xo", "xb-", A),
    j("nt", "n_", A, A),
    j("-----BEGIN RSA PRIVATE ", "KEY-----\nMIIEow\n-----END RSA PRIVATE ", "KEY-----"),
    j('HEDRA_API_KEY="', A, '"'),
    j("password: ", A),
]

CLEAN = [
    "let's risk it and ask her about the task",
    "the password is hunter2",
    "my token count was 45000 today",
    "sk8er boi was a good song",
    "set OPENAI_API_KEY in the env",
    "",
]

fails = 0
for t in REDACTED:
    r = redact(t)
    if r is None or A in r:
        print("MISS:", t[:12]); fails += 1
for t in CLEAN:
    if redact(t) is not None:
        print("FALSE POSITIVE:", t[:60]); fails += 1

assert redact(None) is None and redact(123) is None
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
