"""Which words are real words of a language, by its Hunspell dictionary.

Reads a JSON list of words on stdin, writes a JSON list of booleans to stdout. The dictionary
(sk-spell's Slovak and LibreOffice's Czech and American English Hunspell dictionaries, GPL 2 / LGPL 2.1 / MPL 1.1 (sk) — used unmodified, its README
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
    # the Czech dictionary of the same commit (LGPL 2.1 / GPL; its README names the licence), used unmodified
    "cs": {
        "cs_CZ/cs_CZ.aff": "7ecb20620ecd46ebd9c36f3f33e69dd4eda385cba5b2bb4e6bc396d910e297f7",
        "cs_CZ/cs_CZ.dic": "d8e8c88c006fdae72dac8c85df11b0c99a773e05a4ab0fcbe92244876668ca74",
        "cs_CZ/README_cs.txt": None,
    },
    # American English of the same commit (SCOWL-derived, BSD-style / MIT-like licence in its README), used unmodified
    "en": {
        "en/en_US.aff": "e746c882dd6f303c2c46e7452804b9201115a6942cfeb15f18f8edf774d2e24e",
        "en/en_US.dic": "f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647",
        "en/README_en_US.txt": None,
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
