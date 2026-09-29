---
title: Settings Scopes
description: Where each Ion setting lives, who may change it, and who reads it.
sidebar_position: 5
---

# Settings Scopes

Every persisted setting has one scope. The scope decides where the value is stored, who may change it, and who reads it. The scope of each key is declared once, in `packages/shared/src/settings-registry.ts`, which is the by-name reference.

| Scope | Studio calls it | Belongs to | Stored | Changed by |
|---|---|---|---|---|
| `environment` | Server | The server. One value for everyone on it. | That server's `settings.json` | A connection holding the `admin` scope |
| `account` | Yours on this server | You, but only on that server | That server's per-person overlay (`user-settings/`) | You |
| `personal` | You | You, on every server | Your client | You |
| `device` | This Device | The screen in use | Your client | You |

## Environment settings

An Environment setting is one value for a whole server. Auto-settle, conversation recovery, projects, engine profiles, and the relay and pairing configuration are Environment settings.

Only a connection with the `admin` scope can change one. It does not matter how the connection arrived. A device you paired to your own server holds `admin` and can manage that server from anywhere. A guest on the same server cannot. Each change is logged with who made it.

Auto-settle is an Environment setting on purpose. It files idle conversations away, so the window must not depend on which of your devices happens to connect. Before auto-settle is turned on or its window shortened, Studio asks the server what that would settle right now and shows the count for confirmation.

### Allow settings edits by the agent

This Environment setting decides whether the agent may change the server's own Ion settings files: the engine config (`engine.json`, global and per project), the server's settings document, and the per-person overlays. The server enforces it on every file-writing tool call and on any shell command that names one of those files, so a connected device cannot grant it.

- **Off (default).** The call is refused and nobody is asked.
- **On.** The call is still refused, and the person at the conversation gets the ordinary permission card in Studio and on the phone. **Allow in this conversation** approves that one file for that one conversation until the server restarts. The agent is then told to retry. **Deny** tells the agent to carry on without it.

An organization can seal this setting in the server's enterprise config, under `customFields['ion-server'].agentSettingsEdits.allowed`. A sealed value is the value in force: the server refuses every save of the setting, admin or not, the control is read-only in Studio and on the phone, and the guard reads the seal instead of the saved value.

The enterprise config sources (`ION_ENTERPRISE_CONFIG`, the managed plist, `/etc/ion`, `%ProgramData%\\Ion`) are sealed. The agent can never change them, with the setting on or off, and no approval opens them.

A shell command that names a settings file is refused whatever it does, because what a command does to a file cannot be read from its text. The agent uses `Read` to look at the file.

## Account settings

An Account setting is yours, on one server. It names things that exist only there: your default model from that server's providers, your recent directories, your git mode. Two people on one server each have their own.

Code that runs with nobody connected reads an Account setting for the conversation's owner, not for the host account.

## Personal preferences

A Personal preference is yours on every server, so it lives on your client and no server keeps a settings copy. Your Mac and your iPhone each keep their own.

A server needs a few of them: the mode and thinking level a new conversation starts at, AI-generated titles, `.claude` compatibility, and early-stop continuation. A client declares those to each server on connect. The server stamps them onto every conversation that client creates or prompts, and reads the stamp from then on. That matters because the server often needs the value with nobody connected, for example when it restarts a session after an engine crash.

## Device settings

A Device setting is for the screen in use: the theme, font sizes, panel sizes, keyboard shortcuts.

The idle-repaint warning limits are Device settings for the same reason: they judge this machine's own Studio processes, which no server sees. Studio logs a WARN to `desktop.jsonl` when its GPU helper or a renderer stays above `idleRepaintGpuPercent` (default 10) GPU or `idleRepaintCpuPercent` (default 15) CPU for `idleRepaintSeconds` (default 60) while no Studio window has focus or the machine is idle. They live in `desktop.json` and have no Settings page.

A server stores no Personal preference and no Device setting. `settings.save` refuses one with `settings_wrong_scope`, and the server has no code path that reads one.

## Enterprise policy comes first

Enterprise policy is not a setting and no setting outranks it.

- **Device policy** (theme lock, hidden settings groups) is this device's own. It stays in force whichever server is picked in Settings. A picked server's policy never changes this device's UI. A hidden settings group is also refused on save: every saved key names its settings page in the registry, and the local server refuses a change to any key of a hidden page from this device, so hiding a page is not only cosmetic.
- **Sealed settings** (`customFields['ion-server']`) belong to each server and outrank its own admins. Today that is "Allow settings edits by the agent".
- **Environment policy** (allowed and blocked models, providers) belongs to each server. The Models page offers only what the picked server's policy permits. A saved default model that the server's policy forbids is not used: the server skips it and logs that it did, because the engine refuses a prompt on a forbidden model outright. A model you pick yourself is still sent, and the engine's refusal is the answer.

## In Studio

The Settings sidebar has three headings: **This Device**, **You**, and **Server**. Under **Server** you pick which connected server the pages edit. It opens on the server of the conversation on screen. The Server pages show that server's values and save to it. Without admin access there you can still change what is yours on it, and a server-wide change is put back with a note saying why.

Every list on a Server page is that one server's. The default model lists offer only the models that server has. MCP Servers, Desktop Automation, and Enterprise Auth show and change that server's entries. A default that names a model the server does not have is shown as "not on this server" so you can replace it.

A conversation uses the settings of the server it is on. Its commit command, quick tools, land strategy, conversation profiles, extra project folders, and auto-settle window all come from that server, never from this device's server. An extra folder added from a conversation is saved to that conversation's server.

On the phone, the settings a phone keeps itself are listed under **This iPhone**. Server-wide settings it may not change are shown greyed out.

## Upgrading

On first boot after the upgrade, a server moves any Environment setting out of the local account's personal overlay into `settings.json`. The personal value wins, because that is the value the server was already acting on. Both files are backed up beside themselves as `<file>.pre-scope.bak`. A marker, `.settings-scope-v1`, makes later boots skip the step.

Each client carries over its own settings the first time it loads after the upgrade. They used to be stored on the local server, so the client takes those values once and then keeps them itself. The desktop records that it did this with a marker in its own settings file, because that file answers with shipped defaults for anything never set.

A conversation that existed before the upgrade keeps the Personal preferences its owner had on that server. The values are stamped onto it once, when it is restored.
