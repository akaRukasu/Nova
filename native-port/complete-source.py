"""Complete an existing source snapshot and update its package checksums."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

engine = Path(sys.argv[1]).resolve()
package = Path(sys.argv[2]).resolve()
base = "28174c7227e9b5a7a7dd222378086e88a62cbdb1"
source, = package.glob("*-source.zip")
portable, = package.glob("*-windows-x64.zip")

changed = subprocess.check_output(
    ["git", "diff", "--name-only", "--diff-filter=ACMR", "-z", base], cwd=engine
).decode().strip("\0").split("\0")
replacements = {name: (engine / name).read_bytes() for name in changed}

with zipfile.ZipFile(source) as archive:
    prefix = source.stem + "/"
    for name, content in replacements.items():
        path = prefix + name
        if path in archive.namelist():
            existing = archive.read(path)
            if existing.replace(b"\r\n", b"\n") != content.replace(b"\r\n", b"\n"):
                raise SystemExit(f"The original source differs at {name}")
    temporary = source.with_suffix(".pending.zip")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as complete:
        for entry in archive.infolist():
            if entry.filename.removeprefix(prefix) not in replacements:
                complete.writestr(entry, archive.read(entry))
        for name, content in replacements.items():
            complete.writestr(prefix + name, content)
os.replace(temporary, source)

source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
with zipfile.ZipFile(portable) as archive:
    prefix = portable.stem + "/"
    build = json.loads(archive.read(prefix + "BUILD.json"))
    executable_hash = hashlib.sha256(archive.read(prefix + "voxcord.exe")).hexdigest()
    if executable_hash != build["executable_sha256"]:
        raise SystemExit("The executable differs from its original build record")
    build["source_archive_sha256"] = source_hash
    source_url = os.environ.get("VOXCORD_SOURCE_URL", "")
    reference = archive.read(prefix + "SOURCE.txt").decode("utf-8")
    if source_url:
        lines = reference.splitlines()
        reference = "\n".join(source_url if line.strip().startswith("https://github.com/") else line for line in lines) + "\n"
    updated = {
        prefix + "BUILD.json": (json.dumps(build, indent=2) + "\n").encode(),
        prefix + "SOURCE.txt": reference.encode(),
    }
    temporary = portable.with_suffix(".pending.zip")
    with zipfile.ZipFile(temporary, "w") as output:
        for entry in archive.infolist():
            output.writestr(entry, updated.get(entry.filename, archive.read(entry)))
os.replace(temporary, portable)
print(f"Corresponding source complete, executable SHA-256 {executable_hash}")
