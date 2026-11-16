#!/bin/sh
# Claude Code hook -> Dojo. Registered in ~/.claude/settings.json for SessionStart, UserPromptSubmit,
# PostToolUse, Stop and Notification, with the event name as $1. Forwards the hook JSON (stdin) to the
# Dojo window that owns this tab. Outside Dojo (Warp, VS Code, plain terminal) COCKPIT_SESSION is unset
# and it exits at once. Never prints anything (UserPromptSubmit/SessionStart output would land in
# Claude's context), never fails, never waits longer than one second.
[ -n "$COCKPIT_SESSION" ] && [ -n "$DOJO_PORT" ] && [ "$DOJO_PORT" != "0" ] || exit 0
curl -s -m 1 -o /dev/null -X POST -H "X-Dojo-Token: $DOJO_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @- "http://127.0.0.1:$DOJO_PORT/$1?tab=$COCKPIT_SESSION" >/dev/null 2>&1
exit 0
