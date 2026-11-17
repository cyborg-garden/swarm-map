#!/usr/bin/env python3
"""garden-board: run an org's GitHub project boards from chat.

Read verbs: work, summary, progress. Write verbs: add, move, assign, close,
comment, unboard. Every verb takes --board (default "work"). A board marked
"restricted" in config.json only answers inside its allowed chat channels.

Auth, in order: the Hermes GitHub App helper (hermes_cli.github_app_token), then
our own App JWT mint from GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_B64 (env or
$HERMES_HOME/.env), then GH_TOKEN. A token is never printed or logged.

Never prints issue bodies, money fields, rates or amounts.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.github.com"
UA = "garden-board-skill"
SKILL_DIR = Path(__file__).resolve().parent.parent
HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/opt/data"))
# Board fields that hold money. Never shown, never set.
MONEY_FIELD = re.compile(r"\$|price|rate|amount|bounty \$|pay", re.I)


class Fail(Exception):
    pass


# --------------------------------------------------------------------- config

def load_config() -> dict:
    path = Path(os.environ.get("GARDEN_BOARD_CONFIG", SKILL_DIR / "config.json"))
    if not path.exists():
        raise Fail(f"no config at {path}. Copy config.example.json to config.json and fill it in.")
    cfg = json.loads(path.read_text())
    for k in ("org", "boards", "contracts_repo"):
        if k not in cfg:
            raise Fail(f"config.json is missing '{k}'")
    return cfg


def read_dotenv(key: str) -> str | None:
    try:
        text = (HERMES_HOME / ".env").read_text()
    except OSError:
        return None
    m = re.search(rf"^{re.escape(key)}=(.*)$", text, re.M)
    return re.sub(r"^[\"']|[\"']$", "", m.group(1).strip()) if m else None


# ----------------------------------------------------------------------- auth

def _mint_own(installation_id: str) -> str | None:
    app_id = os.environ.get("GITHUB_APP_ID") or read_dotenv("GITHUB_APP_ID")
    key_b64 = os.environ.get("GITHUB_APP_PRIVATE_KEY_B64") or read_dotenv("GITHUB_APP_PRIVATE_KEY_B64")
    if not app_id or not key_b64:
        return None
    import jwt  # PyJWT[crypto]

    now = int(time.time())
    token = jwt.encode({"iat": now - 60, "exp": now + 540, "iss": app_id},
                       base64.b64decode(key_b64).decode(), algorithm="RS256")
    inst = (os.environ.get("GITHUB_APP_INSTALLATION_ID") or read_dotenv("GITHUB_APP_INSTALLATION_ID")
            or installation_id)
    req = urllib.request.Request(f"{API}/app/installations/{inst}/access_tokens", method="POST",
                                 headers={"Authorization": f"Bearer {token}", "User-Agent": UA,
                                          "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)["token"]


def get_token(cfg: dict) -> str:
    try:
        sys.path.insert(0, "/opt/hermes")
        from hermes_cli.github_app_token import get_installation_token  # type: ignore

        tok = get_installation_token(HERMES_HOME)
        if tok:
            return tok
    except Exception:
        pass
    try:
        tok = _mint_own(str(cfg.get("installation_id", "")))
        if tok:
            return tok
    except Exception as e:
        raise Fail(f"could not mint a GitHub App token ({type(e).__name__})")
    tok = os.environ.get("GH_TOKEN")
    if tok:
        return tok
    raise Fail("no GitHub App credentials found (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_B64)")


class GH:
    def __init__(self, token: str):
        self._h = {"Authorization": f"Bearer {token}", "User-Agent": UA,
                   "Accept": "application/vnd.github+json"}

    def rest(self, method: str, path: str, body: dict | None = None, ok404: bool = False):
        url = path if path.startswith("http") else API + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers=self._h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if ok404 and e.code in (404, 403, 422):
                return None
            msg = e.read().decode(errors="replace")[:300]
            raise Fail(f"GitHub {method} {path.split('?')[0]} failed: HTTP {e.code} {msg}")

    def gql(self, query: str, **variables):
        res = self.rest("POST", "/graphql", {"query": query, "variables": variables})
        if res.get("errors"):
            raise Fail("GitHub GraphQL: " + "; ".join(e.get("message", "?") for e in res["errors"])[:400])
        return res["data"]


# ------------------------------------------------------------------ ops gate

def discord_thread_parent(thread_id: str) -> str | None:
    tok = read_dotenv("DISCORD_BOT_TOKEN")
    if not tok or not thread_id.isdigit():
        return None
    req = urllib.request.Request(f"https://discord.com/api/v10/channels/{thread_id}", headers={
        "Authorization": f"Bot {tok}", "User-Agent": "DiscordBot (https://github.com, 1.0)"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return str(json.load(r).get("parent_id") or "") or None
    except Exception:
        return None


def gate(board_name: str, board: dict) -> None:
    """Refuse a restricted board outside its allowed channels."""
    if not board.get("restricted"):
        return
    allowed = {str(c) for c in board.get("channels", [])}
    platform = os.environ.get("HERMES_SESSION_PLATFORM", "")
    chat = os.environ.get("HERMES_SESSION_CHAT_ID", "")
    thread = os.environ.get("HERMES_SESSION_THREAD_ID", "")
    where = board.get("channel_label", "its private channel")
    if platform == "discord":
        if chat in allowed or thread in allowed:
            return
        for cid in {chat, thread} - {""}:
            if discord_thread_parent(cid) in allowed:
                return
    raise Fail(f"REFUSED: the {board_name} board is private and only works in {where}. "
               f"This request came from somewhere else, so nothing was read or changed. "
               f"Ask again in {where}.")


# -------------------------------------------------------------- board reads

ITEMS_Q = """
query($org:String!,$num:Int!,$after:String){organization(login:$org){projectV2(number:$num){
 id title items(first:100, after:$after){pageInfo{hasNextPage endCursor} nodes{ id
  fieldValues(first:30){nodes{
   ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}
   ... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{name}}}
   ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}}}}
  content{
   ... on DraftIssue{title assignees(first:10){nodes{login name}}}
   ... on Issue{number title url state stateReason repository{nameWithOwner}
     assignees(first:10){nodes{login name}} labels(first:10){nodes{name}}
     closedByPullRequestsReferences(first:10, includeClosedPrs:true){nodes{number url state merged author{login}}}}
   ... on PullRequest{number title url state repository{nameWithOwner} author{login}
     assignees(first:10){nodes{login name}}}}}}}}}"""


def board_items(gh: GH, org: str, num: int) -> tuple[str, list[dict]]:
    out, after, pid = [], None, ""
    while True:
        p = gh.gql(ITEMS_Q, org=org, num=num, after=after)["organization"]["projectV2"]
        if p is None:
            raise Fail(f"project #{num} not found or not readable by the App")
        pid = p["id"]
        for n in p["items"]["nodes"]:
            c = n.get("content") or {}
            fields = {}
            for fv in n["fieldValues"]["nodes"]:
                f = (fv.get("field") or {}).get("name")
                if not f or MONEY_FIELD.search(f):
                    continue
                fields[f] = fv.get("name") or fv.get("text") or fv.get("date")
            out.append({
                "item_id": n["id"], "number": c.get("number"), "title": c.get("title", "(untitled)"),
                "url": c.get("url", ""), "state": c.get("state", "DRAFT"),
                "repo": (c.get("repository") or {}).get("nameWithOwner", ""),
                "assignees": [a["login"] for a in (c.get("assignees") or {}).get("nodes", [])],
                "assignee_names": [a.get("name") or "" for a in (c.get("assignees") or {}).get("nodes", [])],
                "labels": [l["name"] for l in (c.get("labels") or {}).get("nodes", [])],
                "prs": (c.get("closedByPullRequestsReferences") or {}).get("nodes", []),
                "fields": fields,
            })
        if not p["items"]["pageInfo"]["hasNextPage"]:
            return pid, out
        after = p["items"]["pageInfo"]["endCursor"]


def is_open(it: dict) -> bool:
    return it["state"] in ("OPEN", "DRAFT") and it["fields"].get("Stage") != "Done"


def fmt_item(it: dict) -> str:
    f = it["fields"]
    ref = f"#{it['number']}" if it["number"] else "(draft)"
    bits = [f"Stage: {f.get('Stage', '-')}", f"Priority: {f.get('Priority', '-')}"]
    if it["assignees"]:
        bits.append("who: " + ", ".join(it["assignees"]))
    line = f"- {ref} {it['title']} | " + " | ".join(bits)
    if it["prs"]:
        prs = ", ".join(f"PR #{p['number']} ({'merged' if p['merged'] else p['state'].lower()}, by {(p.get('author') or {}).get('login', '?')})" for p in it["prs"])
        line += f"\n    linked: {prs}"
    if it["url"]:
        line += f"\n    {it['url']}"
    return line


# ---------------------------------------------------------- person lookup

def work_files(gh: GH, cfg: dict) -> dict[str, dict]:
    """handle -> parsed front matter (+ '_notes' text) from the contracts repo."""
    import yaml

    repo = f"{cfg['org']}/{cfg['contracts_repo']}"
    d = cfg.get("work_dir", "work")
    listing = gh.rest("GET", f"/repos/{repo}/contents/{d}", ok404=True) or []
    out = {}
    for f in listing:
        name = f["name"]
        if not name.endswith(".md") or name.startswith("_") or name in ("README.md", "BOARD.md"):
            continue
        raw = gh.rest("GET", f"/repos/{repo}/contents/{d}/{name}")
        text = base64.b64decode(raw["content"]).decode()
        m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
        if not m:
            continue
        try:
            fm = yaml.safe_load(m.group(1)) or {}
        except Exception:
            continue
        fm["_notes"] = m.group(2)
        fm["_path"] = f"{d}/{name}"
        out[str(fm.get("handle") or name[:-3]).lower()] = fm
    return out


def resolve_person(gh: GH, cfg: dict, who: str, items: list[dict] | None = None) -> tuple[str, str]:
    """Return (login, display name) for a login or a name."""
    q = who.strip().lstrip("@").lower()
    files = work_files(gh, cfg)
    if q in files:
        return q, str(files[q].get("person") or q)
    hits = [(h, fm) for h, fm in files.items() if q in str(fm.get("person", "")).lower().split() or q == str(fm.get("person", "")).lower()]
    if len(hits) == 1:
        return hits[0][0], str(hits[0][1].get("person"))
    for it in items or []:
        for login, name in zip(it["assignees"], it["assignee_names"]):
            if q == login.lower() or q in name.lower().split():
                return login.lower(), name or login
    u = gh.rest("GET", f"/users/{urllib.parse.quote(q)}", ok404=True)
    if u:
        return u["login"].lower(), u.get("name") or u["login"]
    raise Fail(f"no person matches '{who}'. Give their GitHub login.")


# ----------------------------------------------------------- verification

REF_URL = re.compile(r"https://github\.com/([\w.-]+)/([\w.-]+)/(pull|issues|commit|blob|tree)/([^\s);,>\]]+)")
REF_SHORT = re.compile(r"(?<![\w/.-])(?:([\w.-]+)/)?([\w.-]+)#(\d+)\b")


def extract_refs(text: str, org: str) -> list[tuple]:
    refs, seen = [], set()

    def add(ref):
        owner, repo, kind, rest = ref
        num = re.match(r"\d+", rest) if kind in ("pull", "issues", "ref") else None
        dedupe = (owner.lower(), repo.lower(), num.group(0)) if num else (owner.lower(), repo.lower(), kind, rest)
        if dedupe not in seen:
            seen.add(dedupe)
            refs.append(ref)

    for m in REF_URL.finditer(text or ""):
        add((m.group(1), m.group(2), m.group(3), m.group(4).rstrip(".")))
    for m in REF_SHORT.finditer(REF_URL.sub(" ", text or "")):
        add((m.group(1) or org, m.group(2), "ref", m.group(3)))
    return refs


def verify_ref(gh: GH, ref: tuple, login: str) -> tuple[str, str]:
    """Return (verdict, text). verdict: theirs | partly | not-theirs | unchecked."""
    owner, repo, kind, rest = ref
    name = f"{owner}/{repo}"
    if kind in ("pull", "issues", "ref"):
        num = re.match(r"\d+", rest)
        if not num:
            return "unchecked", f"{name}: unreadable link"
        n = num.group(0)
        pr = gh.rest("GET", f"/repos/{name}/pulls/{n}", ok404=True)
        if pr is None:
            iss = gh.rest("GET", f"/repos/{name}/issues/{n}", ok404=True)
            if iss is None:
                return "unchecked", f"{name}#{n}: could not read (no access or missing)"
            return "unchecked", f"{name}#{n}: an issue, not work; opened by {iss['user']['login']}"
        author = pr["user"]["login"]
        state = "merged" if pr.get("merged_at") else pr["state"]
        label = f"{name}#{n} ({state}, PR by {author})"
        if author.lower() == login:
            return "theirs", label
        commits = gh.rest("GET", f"/repos/{name}/pulls/{n}/commits?per_page=100", ok404=True) or []
        mine = [c for c in commits if ((c.get("author") or {}).get("login") or "").lower() == login]
        if mine:
            return "partly", f"{label}: {len(mine)} of {len(commits)} commits are theirs"
        return "not-theirs", f"{label}: NOT their work"
    if kind == "commit":
        c = gh.rest("GET", f"/repos/{name}/commits/{rest[:40]}", ok404=True)
        if c is None:
            return "unchecked", f"{name}@{rest[:7]}: could not read"
        a = (c.get("author") or {}).get("login") or c["commit"]["author"]["name"]
        return ("theirs" if a.lower() == login else "not-theirs"), f"{name}@{rest[:7]} (commit by {a})"
    # blob/tree: who committed to that path on that ref
    parts = rest.split("/", 1)
    ref_name, path = parts[0], (parts[1] if len(parts) > 1 else "")
    q = urllib.parse.urlencode({"sha": ref_name, "path": path, "per_page": 50})
    commits = gh.rest("GET", f"/repos/{name}/commits?{q}", ok404=True)
    if commits is None and "/" in path:  # branch names can hold slashes
        segs = rest.split("/")
        for i in range(2, len(segs)):
            q = urllib.parse.urlencode({"sha": "/".join(segs[:i]), "path": "/".join(segs[i:]), "per_page": 50})
            commits = gh.rest("GET", f"/repos/{name}/commits?{q}", ok404=True)
            if commits:
                path = "/".join(segs[i:])
                break
    if not commits:
        return "unchecked", f"{name} file {path or rest}: could not read"
    authors = sorted({((c.get("author") or {}).get("login") or c["commit"]["author"]["name"]) for c in commits})
    label = f"{name} file {path.rsplit('/', 1)[-1]} (commits by {', '.join(authors)})"
    if all(a.lower() == login for a in authors):
        return "theirs", label
    if any(a.lower() == login for a in authors):
        return "partly", label
    return "not-theirs", label + ": NOT their work"


# --------------------------------------------------------------- commands

def cmd_work(gh, cfg, args):
    b = cfg["boards"][args.board]
    _, items = board_items(gh, cfg["org"], b["project"])
    login, name = resolve_person(gh, cfg, args.who, items)
    mine = [i for i in items if login in (a.lower() for a in i["assignees"]) and is_open(i)]
    print(f"{name} (@{login}) on {args.board} board: {len(mine)} open item(s)")
    for it in sorted(mine, key=lambda i: (i["fields"].get("Priority") or "P9")):
        print(fmt_item(it))


def cmd_summary(gh, cfg, args):
    b = cfg["boards"][args.board]
    _, items = board_items(gh, cfg["org"], b["project"])
    open_items = [i for i in items if is_open(i)]
    groups: dict[str, list] = {}
    for it in open_items:
        groups.setdefault(it["fields"].get("Stage") or "No stage", []).append(it)
    print(f"{args.board} board: {len(open_items)} open item(s)")
    waiting = sorted(s for s in groups if s.lower().startswith("waiting"))
    for stage in ["In progress", "In review", "Blocked"] + waiting:
        its = groups.pop(stage, [])
        print(f"\n{stage} ({len(its)})")
        for it in its:
            print(fmt_item(it))
    if groups:
        print("\nOther: " + ", ".join(f"{k} {len(v)}" for k, v in sorted(groups.items())))


def field_ids(gh, cfg, num) -> tuple[str, dict]:
    q = """query($org:String!,$num:Int!){organization(login:$org){projectV2(number:$num){id
      fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}"""
    p = gh.gql(q, org=cfg["org"], num=num)["organization"]["projectV2"]
    return p["id"], {f["name"]: f for f in p["fields"]["nodes"] if f}


def set_select(gh, pid, fields, item_id, fname, value):
    if value is None:
        return
    f = fields.get(fname)
    if not f:
        print(f"note: this board has no {fname} field; skipped")
        return
    opt = next((o for o in f["options"] if o["name"].lower() == value.lower()), None)
    if not opt:
        raise Fail(f"{fname} must be one of: {', '.join(o['name'] for o in f['options'])}")
    gh.gql("""mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:
      {projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}""",
           p=pid, i=item_id, f=f["id"], o=opt["id"])


def issue_node(gh, cfg, board, number):
    repo = f"{cfg['org']}/{board['repo']}"
    iss = gh.rest("GET", f"/repos/{repo}/issues/{number}")
    return repo, iss


def item_for(gh, cfg, board, number):
    pid, items = board_items(gh, cfg["org"], board["project"])
    repo = f"{cfg['org']}/{board['repo']}"
    it = next((i for i in items if i["number"] == number and i["repo"].lower() == repo.lower()), None)
    return pid, it


def cmd_add(gh, cfg, args):
    b = cfg["boards"][args.board]
    repo = f"{cfg['org']}/{b['repo']}"
    body = {"title": args.title, "body": args.body or ""}
    if args.type:
        body["labels"] = [args.type]
    if args.assignee:
        body["assignees"] = [a.lstrip("@") for a in args.assignee]
    iss = gh.rest("POST", f"/repos/{repo}/issues", body)
    pid, fields = field_ids(gh, cfg, b["project"])
    item = gh.gql("""mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}""",
                  p=pid, c=iss["node_id"])["addProjectV2ItemById"]["item"]["id"]
    set_select(gh, pid, fields, item, "Stage", args.stage or "Inbox")
    set_select(gh, pid, fields, item, "Priority", args.priority)
    if "Source" in fields:
        set_select(gh, pid, fields, item, "Source", args.source or ("bounty" if args.type == "bounty" else "board"))
    print(f"created #{iss['number']} {iss['title']} on the {args.board} board, Stage {args.stage or 'Inbox'}\n{iss['html_url']}")


def cmd_move(gh, cfg, args):
    b = cfg["boards"][args.board]
    pid, it = item_for(gh, cfg, b, args.number)
    if not it:
        raise Fail(f"#{args.number} is not on the {args.board} board")
    _, fields = field_ids(gh, cfg, b["project"])
    set_select(gh, pid, fields, it["item_id"], "Stage", args.stage)
    set_select(gh, pid, fields, it["item_id"], "Priority", args.priority)
    print(f"#{args.number} updated: " + ", ".join(f"{k} {v}" for k, v in (("Stage", args.stage), ("Priority", args.priority)) if v))


def cmd_assign(gh, cfg, args):
    b = cfg["boards"][args.board]
    repo = f"{cfg['org']}/{b['repo']}"
    logins = [l.lstrip("@") for l in args.login]
    if args.remove:
        gh.rest("DELETE", f"/repos/{repo}/issues/{args.number}/assignees", {"assignees": logins})
    else:
        gh.rest("POST", f"/repos/{repo}/issues/{args.number}/assignees", {"assignees": logins})
    iss = gh.rest("GET", f"/repos/{repo}/issues/{args.number}")
    print(f"#{args.number} assignees now: {', '.join(a['login'] for a in iss['assignees']) or 'nobody'}")


def cmd_close(gh, cfg, args):
    b = cfg["boards"][args.board]
    repo = f"{cfg['org']}/{b['repo']}"
    if args.comment:
        gh.rest("POST", f"/repos/{repo}/issues/{args.number}/comments", {"body": args.comment})
    gh.rest("PATCH", f"/repos/{repo}/issues/{args.number}", {"state": "closed", "state_reason": args.reason})
    if args.reason == "completed":
        pid, it = item_for(gh, cfg, b, args.number)
        if it:
            _, fields = field_ids(gh, cfg, b["project"])
            set_select(gh, pid, fields, it["item_id"], "Stage", "Done")
    print(f"#{args.number} closed ({args.reason.replace('_', ' ')})")


def cmd_comment(gh, cfg, args):
    b = cfg["boards"][args.board]
    repo = f"{cfg['org']}/{b['repo']}"
    c = gh.rest("POST", f"/repos/{repo}/issues/{args.number}/comments", {"body": args.text})
    print(f"commented on #{args.number}: {c['html_url']}")


def cmd_unboard(gh, cfg, args):
    b = cfg["boards"][args.board]
    pid, it = item_for(gh, cfg, b, args.number)
    if not it:
        raise Fail(f"#{args.number} is not on the {args.board} board")
    gh.gql("""mutation($p:ID!,$i:ID!){deleteProjectV2Item(input:{projectId:$p,itemId:$i}){deletedItemId}}""",
           p=pid, i=it["item_id"])
    print(f"#{args.number} removed from the {args.board} board (issue kept)")


def search_all(gh, kind, q):
    out, page = [], 1
    while page <= 5:
        r = gh.rest("GET", f"/search/{kind}?" + urllib.parse.urlencode({"q": q, "per_page": 100, "page": page}), ok404=True)
        if not r:
            break
        out += r["items"]
        if len(r["items"]) < 100:
            break
        page += 1
    return out


def cmd_progress(gh, cfg, args):
    org = cfg["org"]
    b = cfg["boards"]["work"]
    _, items = board_items(gh, org, b["project"])
    login, name = resolve_person(gh, cfg, args.who, items)
    until = args.until or dt.date.today().isoformat()
    since = args.since or (dt.date.fromisoformat(until) - dt.timedelta(days=30)).isoformat()
    print(f"Progress check: {name} (@{login}), activity {since} to {until}")
    print("I do not know contract rates or amounts. 'Verified' means GitHub shows they authored the cited work.\n")

    mine = [i for i in items if login in (a.lower() for a in i["assignees"])]
    print(f"Board: {len(mine)} item(s) assigned")
    for it in mine:
        print(fmt_item(it))
        for p in it["prs"]:
            a = ((p.get("author") or {}).get("login") or "").lower()
            if a and a != login:
                print(f"    ! linked PR #{p['number']} was opened by {a}, not {login}")

    fm = work_files(gh, cfg).get(login)
    if not fm:
        print(f"\nWork file: none found for {login} in {cfg['contracts_repo']}/{cfg.get('work_dir', 'work')}/")
    else:
        print(f"\nWork file {fm['_path']} (updated {fm.get('updated', '?')}), engagement: {fm.get('engagement', '?')}")
        if fm.get("waiting_on") and str(fm["waiting_on"]).lower() != "none":
            print(f"Waiting on: {fm['waiting_on']}")
        for d in fm.get("deliverables") or []:
            status = str(d.get("status", "?"))
            refs = extract_refs(str(d.get("evidence") or ""), org)
            results = [verify_ref(gh, r, login) for r in refs]
            good = [t for v, t in results if v in ("theirs", "partly")]
            if good:
                verdict = "evidence verified"
            elif refs:
                verdict = "evidence NOT verified"
            else:
                verdict = "no evidence" if status != "done" else "claimed done, NO evidence"
            if status == "done" and not good:
                verdict = "claimed done, evidence NOT verified"
            print(f"- {d.get('name', '?')}: {status}; {verdict}")
            for v, t in results:
                print(f"    {'ok' if v == 'theirs' else v}: {t}")
            other = str(d.get("evidence") or "")
            if other and other != "none" and not refs:
                print(f"    (evidence given is not a GitHub link, so not checked: {other[:120]})")
        notes_refs = extract_refs(fm.get("_notes", ""), org)
        if notes_refs:
            print("Also cited in the notes:")
            for r in notes_refs:
                v, t = verify_ref(gh, r, login)
                print(f"    {'ok' if v == 'theirs' else v}: {t}")

    rng = f"{since}..{until}"
    prs = search_all(gh, "issues", f"org:{org} is:pr is:merged author:{login} merged:{rng}")
    print(f"\nMerged PRs by {login} in {org} repos, {rng}: {len(prs)}")
    for p in prs[:25]:
        print(f"- {p['repository_url'].rsplit('/', 1)[-1]}#{p['number']} {p['title']} (merged {p['pull_request'].get('merged_at', '')[:10]})")
    commits = search_all(gh, "commits", f"org:{org} author:{login} author-date:{rng}")
    repos: dict[str, int] = {}
    for c in commits:
        repos[c["repository"]["name"]] = repos.get(c["repository"]["name"], 0) + 1
    print(f"Commits by {login} in {org} repos, {rng}: {len(commits)}"
          + (" (" + ", ".join(f"{r} {n}" for r, n in sorted(repos.items(), key=lambda x: -x[1])) + ")" if repos else ""))
    print("Commit search sees default branches only; work on unmerged branches shows under the PRs and evidence above.")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="garden_board")
    ap.add_argument("--board", default="work", help="board key from config.json (default: work)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("work"); s.add_argument("who")
    sub.add_parser("summary")
    s = sub.add_parser("progress"); s.add_argument("who"); s.add_argument("--since"); s.add_argument("--until")
    s = sub.add_parser("add"); s.add_argument("title"); s.add_argument("--type", choices=["task", "bounty", "deliverable"], default="task")
    s.add_argument("--body"); s.add_argument("--stage"); s.add_argument("--priority"); s.add_argument("--source"); s.add_argument("--assignee", action="append")
    s = sub.add_parser("move"); s.add_argument("number", type=int); s.add_argument("--stage"); s.add_argument("--priority")
    s = sub.add_parser("assign"); s.add_argument("number", type=int); s.add_argument("login", nargs="+"); s.add_argument("--remove", action="store_true")
    s = sub.add_parser("close"); s.add_argument("number", type=int); s.add_argument("--reason", choices=["completed", "not_planned"], required=True); s.add_argument("--comment")
    s = sub.add_parser("comment"); s.add_argument("number", type=int); s.add_argument("text")
    s = sub.add_parser("unboard"); s.add_argument("number", type=int)
    sub.add_parser("auth-check")
    args = ap.parse_args(argv)
    try:
        cfg = load_config()
        if args.board not in cfg["boards"]:
            raise Fail(f"unknown board '{args.board}'. Boards: {', '.join(cfg['boards'])}")
        if args.cmd == "progress":
            args.board = "work"
        gate(args.board, cfg["boards"][args.board])
        gh = GH(get_token(cfg))
        if args.cmd == "auth-check":
            print("GitHub token minted OK (value not shown)")
            return 0
        if args.cmd == "move" and not (args.stage or args.priority):
            raise Fail("move needs --stage and/or --priority")
        {"work": cmd_work, "summary": cmd_summary, "progress": cmd_progress, "add": cmd_add,
         "move": cmd_move, "assign": cmd_assign, "close": cmd_close, "comment": cmd_comment,
         "unboard": cmd_unboard}[args.cmd](gh, cfg, args)
        return 0
    except Fail as e:
        print(f"garden-board: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
