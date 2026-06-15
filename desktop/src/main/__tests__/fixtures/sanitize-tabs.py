#!/usr/bin/env python3
"""
Sanitize a real ~/.ion/tabs-api.json into a fictional, structurally-faithful
fixture for the tab-restoration migration tests.

Goal: preserve EXACTLY the on-disk shape the migration must handle (field
presence patterns, the plain-tab flat fields vs the extension-hosted engine*
maps, instance id keying, message/tool shapes, permissionDenied shapes,
terminal panes) while replacing every identifying detail (titles, filesystem
paths, message content, conversation/session IDs, group IDs, work references)
with deterministic fictional data. Nothing real about the operator's work
survives; only the schema does.

Usage:
    python3 sanitize-tabs.py ~/.ion/tabs-api.json > legacy-tabs.fixture.json

Deterministic: same input → same output (seeded), so fixtures are stable.
"""
import json
import sys
import hashlib

# Deterministic fictional vocabulary — no real project/work references.
FICTIONAL_TITLES = [
    "Garden planner", "Recipe sync", "Trip notes", "Budget review",
    "Bookshelf app", "Weather widget", "Puzzle solver", "Lamp controller",
    "Tea timer", "Map doodles", "Bird log", "Cloud sketch", "Tide chart",
    "Maze runner", "Pixel paint", "Echo bot", "Snail mail", "Kite design",
    "Fern tracker", "Moss notes", "Pebble sort", "Lantern UI",
]
FICTIONAL_DIRS = [
    "/home/fixture/projects/alpha", "/home/fixture/projects/beta",
    "/home/fixture/work/garden", "/home/fixture/work/recipes",
    "/home/fixture/sandbox", "/home/fixture/demo",
]
FICTIONAL_LABELS = [
    "main", "helper one", "helper two", "scratch", "review", "draft",
]


def _hash_int(s: str, mod: int) -> int:
    return int(hashlib.sha256(s.encode()).hexdigest(), 16) % mod


def fict_title(seed: str) -> str:
    return FICTIONAL_TITLES[_hash_int(seed, len(FICTIONAL_TITLES))]


def fict_dir(seed: str) -> str:
    return FICTIONAL_DIRS[_hash_int(seed, len(FICTIONAL_DIRS))]


def fict_label(seed: str) -> str:
    return FICTIONAL_LABELS[_hash_int(seed, len(FICTIONAL_LABELS))]


def fict_text(seed: str, kind: str) -> str:
    # Replace any free text with a short fictional placeholder that keeps the
    # role obvious but carries zero real content.
    n = _hash_int(seed, 1000)
    return f"[fictional {kind} #{n}]"


def fict_path(seed: str) -> str:
    return f"{fict_dir(seed)}/file_{_hash_int(seed, 9999)}.txt"


def sanitize_message(m: dict, ctx: str) -> dict:
    out = {"role": m.get("role"), "timestamp": m.get("timestamp", 0)}
    role = m.get("role")
    if role == "system":
        # Preserve divider sentinels structurally (the migration/restore cares
        # about "── Session started" / "── Plan created" / clear dividers), but
        # neutralize any trailing detail.
        c = m.get("content", "")
        if c.startswith("\u2500\u2500"):  # box-drawing divider prefix
            # keep the divider prefix shape, drop specifics after it
            out["content"] = c.split(" at ")[0] if " at " in c else "\u2500\u2500 divider \u2500\u2500"
        else:
            out["content"] = fict_text(ctx + c[:8], "system")
    elif role == "tool":
        out["content"] = fict_text(ctx, "tool-result")
        out["toolName"] = m.get("toolName")  # tool NAMES are not sensitive
        out["toolId"] = "toolu_" + hashlib.sha256((ctx).encode()).hexdigest()[:24]
        if "toolInput" in m:
            out["toolInput"] = json.dumps({"arg": fict_text(ctx, "tool-input")})
        if "toolStatus" in m:
            out["toolStatus"] = m["toolStatus"]
    else:  # user / assistant / harness
        out["content"] = fict_text(ctx + (m.get("content", "")[:8]), role or "msg")
    if m.get("dedupKey"):
        out["dedupKey"] = m["dedupKey"]  # well-known keys are not sensitive
    if m.get("planFilePath"):
        out["planFilePath"] = fict_path(ctx + "plan")
    return out


def sanitize_denial(d: dict, ctx: str) -> dict:
    if not d or "tools" not in d:
        return d
    tools = []
    for i, t in enumerate(d["tools"]):
        nt = {"toolName": t.get("toolName"), "toolUseId": t.get("toolUseId", "restored")}
        if "toolInput" in t and t["toolInput"]:
            # keep structural shape (e.g. options array) but fictionalize values
            ti = t["toolInput"]
            if isinstance(ti, dict) and "options" in ti:
                nt["toolInput"] = {"options": [fict_text(ctx + str(i) + str(j), "opt")
                                               for j in range(len(ti["options"]))]}
            else:
                nt["toolInput"] = {"planFilePath": fict_path(ctx + str(i))}
        tools.append(nt)
    return {"tools": tools}


def sanitize_instance(inst: dict, tab_seed: str) -> dict:
    iid = inst.get("id", "")
    ctx = tab_seed + iid
    out = dict(inst)
    out["label"] = fict_label(ctx)
    if out.get("modelOverride"):
        out["modelOverride"] = "fictional-model-a"
    if out.get("draftInput"):
        out["draftInput"] = fict_text(ctx + "draft", "draft")
    if out.get("conversationIds"):
        out["conversationIds"] = [f"{1700000000000 + _hash_int(ctx + str(k), 10**11)}-{hashlib.sha256((ctx+str(k)).encode()).hexdigest()[:12]}"
                                  for k in range(len(out["conversationIds"]))]
    if out.get("permissionDenied"):
        out["permissionDenied"] = sanitize_denial(out["permissionDenied"], ctx)
    if out.get("statusFields"):
        sf = dict(out["statusFields"])
        if sf.get("model"):
            sf["model"] = "fictional-model-a"
        sf["label"] = ""
        out["statusFields"] = sf
    return out


def sanitize_tab(tab: dict, idx: int) -> dict:
    seed = f"tab{idx}"
    out = dict(tab)
    if "title" in out:
        out["title"] = fict_title(seed)
    if out.get("customTitle"):
        out["customTitle"] = fict_title(seed)
    if "workingDirectory" in out:
        out["workingDirectory"] = fict_dir(seed)
    # Conversation/session IDs → fictional but same {millis}-{hex} format.
    def fict_cid(s):
        return f"{1700000000000 + _hash_int(s, 10**11)}-{hashlib.sha256(s.encode()).hexdigest()[:12]}"
    if out.get("conversationId"):
        out["conversationId"] = fict_cid(seed + "conv")
    if out.get("lastKnownSessionId"):
        out["lastKnownSessionId"] = fict_cid(seed + "lastknown")
    if out.get("historicalSessionIds"):
        out["historicalSessionIds"] = [fict_cid(seed + f"hist{k}")
                                       for k in range(len(out["historicalSessionIds"]))]
    if out.get("groupId"):
        # keep uuid-ish shape
        out["groupId"] = hashlib.sha256((seed + "grp").encode()).hexdigest()[:8] + "-fixture-group"
    if out.get("draftInput"):
        out["draftInput"] = fict_text(seed + "draft", "draft")
    if out.get("planFilePath"):
        out["planFilePath"] = fict_path(seed + "plan")
    if out.get("lastMessagePreview"):
        out["lastMessagePreview"] = fict_text(seed + "preview", "preview")
    if out.get("modelOverride"):
        out["modelOverride"] = "fictional-model-a"
    if out.get("permissionDenied"):
        out["permissionDenied"] = sanitize_denial(out["permissionDenied"], seed)
    # Extension-hosted maps
    if out.get("engineInstances"):
        out["engineInstances"] = [sanitize_instance(i, seed) for i in out["engineInstances"]]
    if out.get("engineMessages"):
        out["engineMessages"] = {
            k: [sanitize_message(m, seed + k + str(j)) for j, m in enumerate(v)]
            for k, v in out["engineMessages"].items()
        }
    if out.get("engineDenials"):
        out["engineDenials"] = {k: sanitize_denial(v, seed + k)
                                for k, v in out["engineDenials"].items()}
    if out.get("engineModelOverrides"):
        out["engineModelOverrides"] = {k: "fictional-model-a" for k in out["engineModelOverrides"]}
    if out.get("engineSessionIds"):
        out["engineSessionIds"] = {k: fict_cid(seed + k + "sess")
                                   for k in out["engineSessionIds"]}
    if out.get("engineDrafts"):
        out["engineDrafts"] = {k: fict_text(seed + k + "d", "draft")
                               for k in out["engineDrafts"]}
    # Terminal panes attached to conversation tabs — fictionalize cwd/label and
    # drop buffer contents (they carry real shell output / paths).
    if out.get("terminalInstances"):
        ti = []
        for j, t in enumerate(out["terminalInstances"]):
            nt = dict(t)
            if "cwd" in nt:
                nt["cwd"] = fict_dir(seed + "term" + str(j))
            if "label" in nt:
                nt["label"] = fict_label(seed + "term" + str(j))
            ti.append(nt)
        out["terminalInstances"] = ti
    if out.get("terminalBuffers"):
        # Buffer contents are raw terminal output — replace with a placeholder.
        out["terminalBuffers"] = {k: "[fictional terminal buffer]"
                                  for k in out["terminalBuffers"]}
    return out


def main():
    src = sys.argv[1]
    data = json.load(open(src))
    data["tabs"] = [sanitize_tab(t, i) for i, t in enumerate(data["tabs"])]
    if data.get("activeSessionId"):
        # recompute to the (now fictional) active tab's conversationId
        idx = data.get("activeTabIndex", 0)
        if 0 <= idx < len(data["tabs"]):
            data["activeSessionId"] = data["tabs"][idx].get("conversationId")
    # Drop editor states (may carry file paths/content) — not relevant to the
    # tab-migration tests and a source of real data.
    data.pop("editorStates", None)
    json.dump(data, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
