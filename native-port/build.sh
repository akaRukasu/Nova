#!/usr/bin/env bash
set -euo pipefail
# Build the changed native media tests for the same Windows target and run
# their executables on the Windows installer runner, not through emulation.
export SKIA_BINARIES_URL="file://$(python3 nix/prepare-windows-skia.py)"
source scripts/release-env x86_64-pc-windows-msvc
cargo test --locked --release --target x86_64-pc-windows-msvc -p yapfast-discord -p yapfast-core --lib --no-run --message-format=json > target/native-test-binaries.json
python3 - <<'PY'
import json, pathlib, shutil
out = pathlib.Path('target/native-tests')
out.mkdir(exist_ok=True)
shutil.copy2('packaging/windows/yapfast.ico', out / 'voxcord.ico')
found = set()
for line in pathlib.Path('target/native-test-binaries.json').read_text().splitlines():
    item = json.loads(line)
    name = item.get('target', {}).get('name')
    if item.get('profile', {}).get('test') and item.get('executable') and name in ('yapfast_discord', 'yapfast_core'):
        shutil.copy2(item['executable'], out / (name + '.exe'))
        found.add(name)
assert len(found) == 2, found
PY
