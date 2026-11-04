#!/usr/bin/env bash
set -euo pipefail

# signal-register.sh — Register a phone number with Signal via signal-cli
#
# Usage: ./signal-register.sh +15551234567
#
# Environment:
#   SIGNAL_CONTAINER  — Docker container name running signal-cli (default: signal-cli-daemon)
#
# Uses docker exec to run signal-cli commands directly in the daemon container.
# This is the reliable approach — register/verify aren't exposed via JSON-RPC.

CONTAINER="${SIGNAL_CONTAINER:-signal-cli-daemon}"

# --- Helpers ---

usage() {
  echo "Usage: $0 <phone_number>"
  echo "  phone_number: E.164 format (e.g., +15551234567)"
  echo ""
  echo "Environment:"
  echo "  SIGNAL_CONTAINER  Docker container name (default: signal-cli-daemon)"
  exit 1
}

signal_cli() {
  docker exec -i "$CONTAINER" signal-cli "$@"
}

# --- Validation ---

if [[ $# -lt 1 ]]; then
  usage
fi

PHONE="$1"

if [[ ! "$PHONE" =~ ^\+[1-9][0-9]{6,14}$ ]]; then
  echo "Error: Phone number must be in E.164 format (e.g., +15551234567)"
  exit 1
fi

# Check container is running
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Error: Container '$CONTAINER' not found. Is the signal-cli daemon running?"
  exit 1
fi

echo "=== Signal Registration ==="
echo "Phone:     $PHONE"
echo "Container: $CONTAINER"
echo ""

# --- Step 1: Registration ---

echo "[1/4] Requesting registration..."
echo ""

REGISTER_OUTPUT=$(signal_cli -a "$PHONE" register 2>&1) || true
echo "$REGISTER_OUTPUT"
echo ""

# Check if captcha is required
if echo "$REGISTER_OUTPUT" | grep -qi "captcha"; then
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  CAPTCHA REQUIRED                                          ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║  1. Open in your browser:                                  ║"
  echo "║     https://signalcaptchas.org/registration/generate.html  ║"
  echo "║                                                            ║"
  echo "║  2. Solve the captcha                                      ║"
  echo "║                                                            ║"
  echo "║  3. Right-click 'Open Signal' → Copy link address          ║"
  echo "║                                                            ║"
  echo "║  4. Paste the full signalcaptcha://... URL below           ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  read -rp "Paste captcha token: " CAPTCHA_RAW

  # Strip the signalcaptcha:// prefix if present
  CAPTCHA="${CAPTCHA_RAW#signalcaptcha://}"

  if [[ -z "$CAPTCHA" ]]; then
    echo "Error: No captcha token provided."
    exit 1
  fi

  echo ""
  echo "[1/4] Retrying registration with captcha..."
  signal_cli -a "$PHONE" register --captcha "$CAPTCHA" 2>&1 || {
    echo "Error: Registration failed with captcha."
    exit 1
  }
  echo ""
fi

echo "Registration request sent. Check SMS Pool for the verification code."
echo ""

# --- Step 2: Verification ---

echo "[2/4] Enter verification code"
echo "  Check your SMS Pool dashboard for the 6-digit code sent to $PHONE"
echo ""
read -rp "Verification code (6 digits): " VERIFY_CODE

# Strip spaces/dashes
VERIFY_CODE="${VERIFY_CODE//[- ]/}"

if [[ ! "$VERIFY_CODE" =~ ^[0-9]{6}$ ]]; then
  echo "Error: Verification code must be exactly 6 digits."
  exit 1
fi

echo ""
echo "[3/4] Verifying code..."
signal_cli -a "$PHONE" verify "$VERIFY_CODE" 2>&1 || {
  echo "Error: Verification failed."
  exit 1
}

echo "Verification successful!"
echo ""

# --- Step 3: Set Display Name ---

echo "[4/4] Set display name for this Signal account"
read -rp "Display name (e.g., 'Hermes Generalist'): " DISPLAY_NAME

if [[ -n "$DISPLAY_NAME" ]]; then
  signal_cli -a "$PHONE" updateProfile --given-name "$DISPLAY_NAME" 2>&1 || {
    echo "Warning: Could not set display name (non-fatal)"
  }
  echo "Display name set to: $DISPLAY_NAME"
else
  echo "Skipping display name."
fi

echo ""

# --- Step 4: Verify account is live ---

echo "Verifying account is registered..."
signal_cli -a "$PHONE" listAccounts 2>&1 || true
echo ""

# --- Summary ---

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  REGISTRATION COMPLETE                                     ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Add these to your agent's .env file:                      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  SIGNAL_HTTP_URL=http://signal-cli-daemon:8080"
echo "  SIGNAL_ACCOUNT=$PHONE"
echo "  SIGNAL_ALLOWED_USERS=0"
echo "  SIGNAL_GROUP_ALLOWED_USERS="
echo ""
echo "  SIGNAL_ALLOWED_USERS: 0 means nobody can DM. Replace it with phone numbers to allow them. Empty is NOT closed."
echo "  SIGNAL_GROUP_ALLOWED_USERS: empty means no preset groups. People on SIGNAL_ALLOWED_USERS can still add the agent to groups."
echo ""
echo "Then restart the agent. It will connect to the daemon automatically."
echo ""
echo "Done."
