#!/usr/bin/env bash
# Select the newest installed iPhone Simulator with a usable data directory.

select_ios_simulator() {
  xcrun simctl list devices available -j | python3 -c '
import json
import os
import re
import sys

payload = json.load(sys.stdin)
choices = []
for runtime, devices in payload.get("devices", {}).items():
    match = re.fullmatch(r"com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+)-(\d+)", runtime)
    if not match:
        continue
    version = tuple(int(part) for part in match.groups())
    for device in devices:
        name = device.get("name", "")
        data_path = device.get("dataPath", "")
        if (
            device.get("isAvailable")
            and name.startswith("iPhone ")
            and os.path.isdir(data_path)
        ):
            choices.append((version, name, device["udid"]))

if choices:
    version, name, udid = max(choices)
    print(f"{version[0]}.{version[1]}|{name}|{udid}")
'
}
