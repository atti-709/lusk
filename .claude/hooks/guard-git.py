"""PreToolUse guard for Bash: no push to main, Conventional Commits only.

Rules with zero exceptions live here instead of CLAUDE.md (every push to main used to ship a
release; the commit convention is checked by nobody else). Exit 2 blocks the command and the
message on stderr is shown to Claude. Anything this script can't parse is allowed through.
"""
import json
import re
import subprocess
import sys

TYPES = "feat|fix|refactor|perf|test|docs|build|ci|chore"
CONVENTIONAL = re.compile(rf"^({TYPES})(\([a-z0-9][a-z0-9./-]*\))?!?: [a-z0-9]")

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
command = str(data.get("tool_input", {}).get("command", ""))
cwd = data.get("cwd") or "."
if not re.search(r"\bgit\b", command):
    sys.exit(0)


def deny(reason: str) -> None:
    print(reason, file=sys.stderr)
    sys.exit(2)


# --- pushes ---------------------------------------------------------------------------------
for push in re.finditer(r"\bgit\s+(?:-C\s+\S+\s+)?push\b([^|;&]*)", command):
    args = push.group(1)
    words = [w for w in args.split() if not w.startswith("-")]
    refspecs = words[1:]  # the first non-option word is the remote
    targets = [r.split(":")[-1].strip("+") for r in refspecs]
    if any(t in ("main", "refs/heads/main") for t in targets):
        deny("Pushing to main is not allowed: open a pull request and let the owner merge it.")
    if not refspecs:
        try:
            branch = subprocess.run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
                                    capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            branch = ""
        if branch == "main":
            deny("You are on main: pushing it is not allowed. Work on a branch and open a pull request.")

# --- commit messages ------------------------------------------------------------------------
for commit in re.finditer(r"\bgit\s+(?:-C\s+\S+\s+)?commit\b([^|;&]*(?:\$\(cat <<'?EOF'?[\s\S]*?EOF\s*\))?[^|;&]*)", command):
    args = commit.group(1)
    if "--amend" in args and "-m" not in args and "--message" not in args:
        continue
    # the heredoc form first: inside "$(cat <<'EOF' ... )" the quoted-string form would swallow it whole
    m = re.search(r"""(?:-m|--message)(?:=|\s+)"?\$\(cat <<'?EOF'?\n([^\n]*)""", args) \
        or re.search(r"""(?:-m|--message)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)')""", args)
    if not m:
        continue  # editor, -F file or a form this guard can't read
    subject = next(s for s in m.groups() if s is not None).strip()
    if not CONVENTIONAL.match(subject):
        deny(f"Commit subject must follow Conventional Commits: <type>(<scope>): <lowercase imperative description>, "
             f"types {TYPES}. Got: {subject!r}")
    if subject.endswith("."):
        deny("Commit subject must not end with a period.")
sys.exit(0)
