# Terminal Activity and Web Application discovery

The Desktop main process owns every Terminal PTY. It records the complete descendant process tree for each PTY and publishes Terminal Activity only when the record changes.

## Ownership

A single bounded `ps` snapshot supplies all process parent relationships. The Desktop walks descendants from each PTY shell PID. This gives exact ownership for nested launchers such as `npm` → `node`; executable names and output text are not ownership signals.

Conversation Terminal keys begin with the owning Conversation ID. Studio Surface Terminals use `<conversation-id>:surface:<instance-id>`, so they aggregate to the same Conversation without colliding with the Conversation Terminal panel.

## Web Application confirmation

The Desktop discovers all local TCP listeners with `lsof`; it does not use a fixed port list. A listener is associated with a Terminal only when its PID is in that Terminal's process tree. Loopback and wildcard listeners are candidates.

A candidate becomes a Web Application only after a bounded HTTP or HTTPS request returns HTML/XHTML or a redirect. Positive and negative results are cached for 15 seconds by URL and listener PID. Listener discovery runs at most every three seconds and scans never overlap.

Docker Compose attribution uses structured Docker container port data only while the Docker client is part of the live Terminal process tree. Detached containers are not attributed to the old Terminal.

## Client behavior

- A confirmed Web Application renders a pink Globe action.
- Other Terminal Activity renders a pink Terminal icon.
- Process and URL details appear in the hover text, not inline.
- Terminal Activity is background-shell work. Foreground agent work and running agents keep higher status priority.
- Desktop snapshots provide first-paint truth. Live `desktop_terminal_activity` events keep iOS current.
