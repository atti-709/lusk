"""Which words are real words of a language, by its Hunspell dictionary.

Reads a JSON list of words on stdin, writes a JSON list of booleans to stdout. The dictionary
(sk-spell's Slovak Hunspell dictionary, GPL 2 / LGPL 2.1 / MPL 1.1 — used unmodified, its README
with the license is kept beside it) is downloaded once from a pinned LibreOffice commit and
checked against its hash.
"""

import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path

COMMIT = "75f5dff8c972fff4a32e4ea8434722c277f02a3f"
BASE = f"https://raw.githubusercontent.com/LibreOffice/dictionaries/{COMMIT}"
DICTIONARIES = {
    "sk": {
        "sk_SK/sk_SK.aff": "af67bbe8ea9dea74968ec01acd266b3f74177ca087ee6eb7898c576e0aef7a3d",
        "sk_SK/sk_SK.dic": "3e3dbd5c6af8431a3a47652c69692f3f86d0cd82deb4418e49a057a33ef56063",
        "sk_SK/README_sk.txt": None,
    },
}


def dictionary(lang: str) -> Path:
    home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "lusk-hunspell" / COMMIT[:12]
    for name, digest in DICTIONARIES[lang].items():
        target = home / name
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        data = urllib.request.urlopen(f"{BASE}/{name}", timeout=120).read()
        if digest and hashlib.sha256(data).hexdigest() != digest:
            sys.exit(f"{name}: downloaded file does not match its pinned hash")
        partial = target.parent / (target.name + ".partial")
        partial.write_bytes(data)
        partial.rename(target)
    aff = next(n for n in DICTIONARIES[lang] if n.endswith(".aff"))
    return home / aff[:-4]


def main() -> None:
    lang = sys.argv[1] if len(sys.argv) > 1 else "sk"
    words = json.load(sys.stdin)
    if lang not in DICTIONARIES:
        json.dump([True] * len(words), sys.stdout)
        return
    from spylls.hunspell import Dictionary

    d = Dictionary.from_files(str(dictionary(lang)))
    json.dump([bool(w) and bool(d.lookup(w) or d.lookup(w.lower())) for w in words], sys.stdout)


if __name__ == "__main__":
    main()
