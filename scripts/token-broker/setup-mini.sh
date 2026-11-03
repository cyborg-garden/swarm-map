#!/bin/bash
# Runs on the host, from the unpacked payload. ghkey setup calls it. Safe to re-run.
# usage: setup-mini.sh <app_id> <installation_id>
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
app_id="$1"; installation_id="$2"
port=8799
dir="$HOME/.config/hermes/github-app"
label="garden.github-token-broker"
plist="$HOME/Library/LaunchAgents/$label.plist"
uid_now="$(id -u)"

node_bin="$(command -v node)" || { echo "node not found" >&2; exit 1; }
mkdir -p "$dir" "$HOME/bin" "$HOME/Library/LaunchAgents"
chmod 700 "$dir"

if [ -f "$dir/registry.json" ]; then chmod 600 "$dir/registry.json"; fi
if [ -f "$dir/private-key.pem" ]; then chmod 600 "$dir/private-key.pem"; fi
umask 077
cat > "$dir/config.json" <<JSON
{ "app_id": "$app_id", "installation_id": "$installation_id", "port": $port }
JSON

cat > "$HOME/bin/github-broker" <<WRAP
#!/bin/bash
# Non-interactive ssh has a thin PATH, so node and docker are found here.
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
exec "$node_bin" "$dir/bin/broker.mjs" "\$@"
WRAP
chmod 755 "$HOME/bin/github-broker"

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$HOME/bin/github-broker</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$dir/broker.log</string>
  <key>StandardErrorPath</key><string>$dir/broker.log</string>
</dict>
</plist>
PLIST

# gui/ needs a login session and user/ does not, so try both.
launchctl bootout "gui/$uid_now/$label" 2>/dev/null || launchctl bootout "user/$uid_now/$label" 2>/dev/null || true
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $port is taken by something else. Nothing started." >&2
  exit 1
fi
launchctl bootstrap "gui/$uid_now" "$plist" 2>/dev/null || launchctl bootstrap "user/$uid_now" "$plist"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    echo "Broker running on 127.0.0.1:$port."
    exit 0
  fi
  sleep 1
done
echo "Broker did not come up. Look at $dir/broker.log" >&2
exit 1
