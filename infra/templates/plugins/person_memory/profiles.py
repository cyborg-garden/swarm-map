"""Person-profile loading + adaptation-directive assembly.

Profiles are image-only markdown files at::

    <memory_dir>/people/<platform>:<user_id>.md

with a small frontmatter header the injector reads::

    ---
    display_name: Alex
    role: community organiser (non-technical)
    technical_level: concept
    comm_style: warm, narrative, analogy-first; avoid jargon
    last_updated: 2026-07-17
    source: declared
    ---

    ## Notable context
    - ...

Stdlib-only (no PyYAML — matches the zero-dependency plugin style) and
strictly fail-open: any malformed input returns ``None`` / ``{}`` rather
than raising, so a bad profile can never break a turn.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional

# Identity components are interpolated into a filesystem path, so we hard-reject
# anything that could traverse (``/``, ``\``, ``..``) or inject NUL/whitespace.
# This allowlist covers every real Slack/Telegram/Discord id, the ``slack:U…``
# scheme, and E.164 phone numbers (``+64…`` — Signal presents these as sender
# ids), while making the profile path un-escapable regardless of how trusted
# the calling connector's id happens to be.
_ID_RE = re.compile(r"^[A-Za-z0-9._:+-]+$")


def _coerce(v: str) -> Any:
    v = v.strip()
    if v.startswith("[") and v.endswith("]"):
        return [x.strip() for x in v[1:-1].split(",") if x.strip()]
    return v


def parse_frontmatter(text: str) -> Dict[str, Any]:
    """Parse a leading ``---`` frontmatter block. Returns a dict of scalar
    fields plus ``_body`` (everything after the block). Never raises."""
    meta: Dict[str, Any] = {}
    lines = text.splitlines()
    body_start = 0
    if lines and lines[0].strip() == "---":
        i = 1
        while i < len(lines) and lines[i].strip() != "---":
            line = lines[i]
            if ":" in line and not line.lstrip().startswith("#"):
                k, _, val = line.partition(":")
                key = k.strip()
                if key:
                    meta[key] = _coerce(val)
            i += 1
        body_start = i + 1 if i < len(lines) else len(lines)
    meta["_body"] = "\n".join(lines[body_start:]).strip()
    return meta


def extract_section(body: str, heading: str) -> str:
    """Return the text under a ``## <heading>`` section (until the next
    ``##`` heading or EOF), stripped. Empty string if absent."""
    out = []
    capturing = False
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            capturing = stripped[3:].strip().lower() == heading.strip().lower()
            continue
        if capturing:
            out.append(line)
    return "\n".join(out).strip()


def profile_path(memory_dir: str, platform: str, user_id: str) -> str:
    return os.path.join(memory_dir, "people", "%s:%s.md" % (platform, user_id))


def load_profile(memory_dir: str, platform: str, user_id: str) -> Optional[Dict[str, Any]]:
    """Load + parse a person profile. Returns ``None`` on any miss/error."""
    if not memory_dir or not platform or not user_id:
        return None
    # Defense-in-depth: never build a path from an id that could escape people/.
    if not (_ID_RE.match(platform) and _ID_RE.match(user_id)):
        return None
    path = profile_path(memory_dir, platform, user_id)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return None
    try:
        meta = parse_frontmatter(text)
    except Exception:
        return None
    # A usable profile needs at least an adaptation signal.
    if not (meta.get("technical_level") or meta.get("comm_style") or meta.get("display_name")):
        return None
    return meta


def load_alias_ids(data_dir: str, platform: str, user_id: str) -> List[str]:
    """Alternate ids the same sender is known by, from Swarm Map's
    ``<data_dir>/resolved-identities.json``.

    Swarm Map resolves admin-entered identities to platform-native ids and
    stores both forms per platform::

        {"signal": [{"display": "+<E.164 phone number>",
                     "nativeId": "<ACI UUID>",
                     "profileName": "Alex"}]}

    Signal is the motivating case: an envelope carries ``sourceNumber`` OR
    ``sourceUuid`` depending on the sender, so a profile keyed by one form
    misses when the connector presents the other. This maps whichever form
    was presented to every other known form so the profile fires either way.

    Returns allowlist-safe alternates (never ``user_id`` itself), in file
    order, deduped. ``[]`` on any miss/error — fail-open like everything
    else in this plugin.
    """
    if not data_dir or not platform or not user_id:
        return []
    try:
        with open(os.path.join(data_dir, "resolved-identities.json"), "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    entries = data.get(platform)
    if not isinstance(entries, list):
        return []
    aliases: List[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        display = str(entry.get("display") or "").strip()
        native = str(entry.get("nativeId") or "").strip()
        if user_id == display and native:
            aliases.append(native)
        elif user_id == native and display:
            aliases.append(display)
    seen = set()
    out: List[str] = []
    for a in aliases:
        if a != user_id and a not in seen and _ID_RE.match(a):
            seen.add(a)
            out.append(a)
    return out


def build_directive(profile: Dict[str, Any]) -> Optional[str]:
    """Assemble the ephemeral adaptation directive appended to the user
    message. Tone/depth only — never changes facts or shared context."""
    if not profile:
        return None
    name = str(profile.get("display_name") or "this person").strip()
    role = str(profile.get("role") or "").strip()
    tech = str(profile.get("technical_level") or "").strip()
    style = str(profile.get("comm_style") or "").strip()
    notable = extract_section(str(profile.get("_body") or ""), "Notable context")

    who = "You are speaking with %s%s." % (name, (" (%s)" % role) if role else "")
    adapt = []
    if tech:
        adapt.append("technical depth = %s" % tech)
    if style:
        adapt.append("communication style = %s" % style)
    parts = [who]
    if adapt:
        parts.append("Adapt HOW you say things for them: %s." % "; ".join(adapt))
    if notable:
        # keep it compact — first ~3 non-empty lines
        lines = [ln.strip("-* \t") for ln in notable.splitlines() if ln.strip()]
        if lines:
            parts.append("Context on them: %s" % " ".join(lines[:3]))
    parts.append(
        "This changes tone and depth only — the facts, decisions, and shared "
        "context stay identical for everyone."
    )
    directive = " ".join(p for p in parts if p).strip()
    return directive or None
