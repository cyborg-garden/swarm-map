#!/bin/sh
# Written by Swarm Map from the rules record. Do not edit: it is written again on every save and every start.
export SMLAB_DISCORD_TOKEN_FILE='__TMP__/keys/token'
export SMLAB_MODEL_KEY_FILE='__TMP__/keys/key'
export SMLAB_STATE_DIR='__TMP__/data/door-agents/h_pi_one/state'
exec '/fake/node' '/fake/repo/lib/lab/pi-discord/cli.ts' start --config '__TMP__/data/door-agents/h_pi_one/config.json'
