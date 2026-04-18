# Slash Command Capability Matrix

CLI Version: 2.1.63 | Date: 2026-03-08
Test session: 450d2d0f-4b03-4761-8ecd-8d179998127d

## Protocol Finding

`--input-format stream-json` is **completely broken** in CLI 2.1.63 (hangs forever, 0 events).
The only working mode is one-shot `claude -p` with stdin closed + `--resume` for multi-turn.

## Command Matrix

| Command | Fresh | With Session | Events | Result Preview | Verdict |
|---------|-------|-------------|--------|---------------|---------|
| `/help` | ✅ | ✅ | system/init, result/success | Unknown skill: help | **works_native** |
| `/model` | ✅ | ✅ | system/init, result/success | Unknown skill: model | **works_native** |
| `/mcp` | ✅ | ✅ | system/init, result/success | Unknown skill: mcp | **works_native** |
| `/status` | ✅ | ✅ | system/init, result/success | Unknown skill: status | **works_native** |
| `/clear` | ✅ | ✅ | system/init, result/success | Unknown skill: clear | **works_native** |
| `/compact` | ✅ | ✅ | system/status, rate_limit_event, system/init, system/compact_boundary, user, result/success |  | **unsupported** |
| `/doctor` | ✅ | ✅ | system/init, result/success | Unknown skill: doctor | **works_native** |
| `/permissions` | ✅ | ✅ | system/init, result/success | Unknown skill: permissions | **works_native** |
| `/cost` | ✅ | ✅ | system/init, assistant, result/success | You are currently using your subscription to power | **passthrough_to_model** |

## Verdict Key

- **works_native**: CLI intercepts the command and returns structured output (no model call)
- **passthrough_to_model**: CLI sends it to the model as a regular prompt (model responds)
- **silent_exit**: CLI handles it internally but produces no result event in stream-json
- **unsupported**: Command not recognized or errors out

## Detailed Results

### `/help`
- Verdict: **works_native**
- Exit code: 0
- Events: system/init → result/success
- Is error: false
- Result text:
```
Unknown skill: help
```

### `/model`
- Verdict: **works_native**
- Exit code: 0
- Events: system/init → result/success
- Is error: false
- Result text:
```
Unknown skill: model
```

### `/mcp`
- Verdict: **works_native**
- Exit code: 0
- Events: system/init → result/success
- Is error: false
- Result text:
```
Unknown skill: mcp
```

### `/status`
- Verdict: **works_native**
- Exit code: 0
- Events: system/init → result/success
- Is error: false
- Result text:
```
Unknown skill: status
```

### `/clear`
- Verdict: **works_native**
- Exit code: 0
- Events: system/init → result/success
- Is error: false
- Result text:
```
Unknown skill: clear
```

### `/compact`
- Verdict: **unsupported**
- Exit code: 0
- Events: system/status → rate_limit_event → system/status → system/init → system/compact_boundary → user → user → result/success
- Is error: false
- Result text:
```
(empty)
```

### `/doctor`
- Verdict: **works_native**
- Exit code: 0
- Events: system/init → result/success
- Is error: false
- Result text:
```
Unknown skill: doctor
```

### `/permissions`
- Verdict: **works_native**
- Exit code: 0
- Events: system/init → result/success
- Is error: false
- Result text:
```
Unknown skill: permissions
```

### `/cost`
- Verdict: **passthrough_to_model**
- Exit code: 0
- Events: system/init → assistant → result/success
- Is error: false
- Result text:
```
You are currently using your subscription to power your Claude Code usage
```
