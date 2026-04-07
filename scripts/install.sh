#!/usr/bin/env bash
# GRVT Grid — interactive installer.
#
# Walks a self-hoster through:
#   1. Verifying Docker + Docker Compose are installed
#   2. Generating a fresh DASHBOARD_API_KEY
#   3. Prompting for GRVT credentials, Telegram (optional), domain (optional)
#   4. Writing .env from .env.example
#   5. docker compose build + up
#   6. Health check + first-run smoke
#
# Run from the repo root:
#     ./scripts/install.sh
#
# Re-runs are idempotent: if .env already exists, it backs it up and asks
# whether to keep existing values.

set -euo pipefail

# ── Style helpers ────────────────────────────────────────────────────────
BOLD=$'\033[1m'
DIM=$'\033[2m'
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
CYAN=$'\033[36m'
RESET=$'\033[0m'

heading() { printf '\n%s━━━ %s ━━━%s\n' "$CYAN$BOLD" "$1" "$RESET"; }
ok()      { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()    { printf '%s⚠%s %s\n' "$YELLOW" "$RESET" "$1"; }
err()     { printf '%s✗%s %s\n' "$RED" "$RESET" "$1" >&2; }
prompt()  { printf '%s? %s%s ' "$BOLD" "$1" "$RESET"; }

require_repo_root() {
    if [[ ! -f docker-compose.yml ]] || [[ ! -d packages/bot ]]; then
        err "Run this from the GRVT Grid repo root (where docker-compose.yml lives)."
        exit 1
    fi
}

require_docker() {
    heading "Checking prerequisites"

    if ! command -v docker >/dev/null 2>&1; then
        err "Docker is not installed. Install Docker Engine first:"
        echo "  https://docs.docker.com/engine/install/"
        exit 1
    fi
    ok "Docker found ($(docker --version))"

    if ! docker compose version >/dev/null 2>&1; then
        err "Docker Compose v2 is not installed. Install with:"
        echo "  https://docs.docker.com/compose/install/"
        exit 1
    fi
    ok "Docker Compose found ($(docker compose version --short))"

    if ! docker info >/dev/null 2>&1; then
        err "Cannot reach the Docker daemon. Is it running? Try: systemctl start docker"
        exit 1
    fi
    ok "Docker daemon reachable"
}

backup_existing_env() {
    if [[ -f .env ]]; then
        local backup=".env.backup.$(date +%s)"
        cp .env "$backup"
        warn ".env already exists — backed up to $backup"
        prompt "Keep existing values and only fill in missing ones? [Y/n]"
        read -r answer
        if [[ "${answer:-Y}" =~ ^[Nn] ]]; then
            rm .env
            ok "Existing .env removed. Starting fresh."
        else
            ok "Reusing existing .env values."
            return 0
        fi
    fi
    cp .env.example .env
    chmod 600 .env
}

generate_api_key() {
    if grep -q '^DASHBOARD_API_KEY=$' .env || grep -q '^DASHBOARD_API_KEY=replace' .env; then
        local key
        key=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64)
        sed -i.tmp "s|^DASHBOARD_API_KEY=.*|DASHBOARD_API_KEY=$key|" .env
        rm .env.tmp
        ok "Generated DASHBOARD_API_KEY (saved to .env)"
    else
        ok "DASHBOARD_API_KEY already set"
    fi
}

prompt_value() {
    local key=$1
    local description=$2
    local default=${3:-}
    local current
    current=$(grep "^$key=" .env | head -1 | cut -d= -f2-)

    if [[ -n "$current" ]] && [[ "$current" != "0x..." ]] && [[ "$current" != "change-me" ]]; then
        ok "$key is set (keeping existing value)"
        return 0
    fi

    printf '\n%s%s%s\n' "$DIM" "$description" "$RESET"
    if [[ -n "$default" ]]; then
        prompt "$key [default: $default]:"
    else
        prompt "$key:"
    fi
    read -r value
    value=${value:-$default}

    # sed escape: handle / and & in value
    local escaped
    escaped=$(printf '%s\n' "$value" | sed 's/[\/&]/\\&/g')
    sed -i.tmp "s|^$key=.*|$key=$escaped|" .env
    rm .env.tmp
}

prompt_grvt_credentials() {
    heading "GRVT API credentials"
    cat <<EOF
Get these from your GRVT account UI:
  https://grvt.io  →  Account  →  API Keys

IMPORTANT: register your GRVT account through the referral link the project
shares (otherwise this self-host build is not authorized for redistribution).

EOF
    prompt_value GRVT_API_KEY        "Your GRVT API key (NOT the secret)"
    prompt_value GRVT_API_SECRET     "Your GRVT API secret (the EIP-712 signing key, starts with 0x)"
    prompt_value GRVT_TRADING_ACCOUNT_ID "Your trading sub-account id (numeric)"
    prompt_value GRVT_TRADING_ADDRESS    "Your trading account address (starts with 0x)"
}

prompt_dashboard_legacy() {
    heading "Dashboard auth (legacy basic auth)"
    cat <<EOF
The legacy v1 dashboard is still mounted at /. The new v2 dashboard at
/dashboard/ uses your DASHBOARD_API_KEY. You can leave these defaults if
you'll only use /dashboard/.

EOF
    prompt_value DASHBOARD_USER "Basic auth username" "admin"
    prompt_value DASHBOARD_PASS "Basic auth password" "$(openssl rand -base64 12 2>/dev/null || echo change-me)"
}

prompt_telegram() {
    heading "Telegram notifier (optional)"
    cat <<EOF
Skip with empty values to disable. To enable:
  1. Talk to @BotFather on Telegram, /newbot
  2. Send your new bot any message
  3. Get your chat id from
       https://api.telegram.org/bot<TOKEN>/getUpdates

EOF
    prompt_value TELEGRAM_BOT_TOKEN "Telegram bot token (or leave empty)"
    prompt_value TELEGRAM_CHAT_ID   "Telegram chat id (or leave empty)"
}

choose_profile() {
    heading "Deployment profile"
    cat <<EOF
Pick a deployment style:

  1) bot only          — just the engine + dashboard on http://localhost:${BOT_PORT:-3848}
  2) bot + notifier    — adds the Telegram sidecar (requires Telegram creds)
  3) bot + caddy + tls — adds Caddy reverse proxy with HTTPS (needs a domain)
  4) full              — all of the above

EOF
    prompt "Choice [1-4, default 1]:"
    read -r choice
    case "${choice:-1}" in
        1) echo ""; ;;
        2) echo "with-notifier"; ;;
        3) echo "with-tls"; ;;
        4) echo "full"; ;;
        *) warn "Invalid choice, defaulting to 1"; echo ""; ;;
    esac
}

build_and_start() {
    local profile=$1
    heading "Building and starting"

    local profile_arg=()
    if [[ -n "$profile" ]]; then
        profile_arg=(--profile "$profile")
    fi

    docker compose "${profile_arg[@]}" build
    docker compose "${profile_arg[@]}" up -d

    ok "Containers started"
}

wait_for_health() {
    heading "Waiting for bot to become healthy"
    local n=0
    while (( n < 60 )); do
        if curl -fs http://127.0.0.1:${BOT_PORT:-3848}/api/health >/dev/null 2>&1; then
            ok "Bot is healthy"
            curl -s http://127.0.0.1:${BOT_PORT:-3848}/api/health
            echo
            return 0
        fi
        sleep 2
        n=$((n+1))
        printf '.'
    done
    err "Bot did not become healthy in 120s. Check logs: docker compose logs -f bot"
    return 1
}

print_next_steps() {
    local key
    key=$(grep '^DASHBOARD_API_KEY=' .env | cut -d= -f2-)
    cat <<EOF

${GREEN}${BOLD}━━━ All done ━━━${RESET}

${BOLD}Dashboard URL:${RESET}
  http://localhost:${BOT_PORT:-3848}/dashboard/

${BOLD}API key (for the dashboard):${RESET}
  $key

${BOLD}Useful commands:${RESET}
  docker compose logs -f bot       # follow bot logs
  docker compose logs -f notifier  # follow notifier (if enabled)
  docker compose stop bot          # graceful stop (preserves GRVT orders)
  docker compose down              # stop everything

${BOLD}Next steps:${RESET}
  1. Open the dashboard URL above and enter the API key when prompted.
  2. Verify your bot appears in the Overview page.
  3. Read docs/SELF_HOST.md for backup, monitoring and TLS setup.

EOF
}

main() {
    require_repo_root
    require_docker
    heading "Setting up .env"
    backup_existing_env
    generate_api_key
    prompt_grvt_credentials
    prompt_dashboard_legacy
    prompt_telegram
    profile=$(choose_profile)
    build_and_start "$profile"
    wait_for_health
    print_next_steps
}

main "$@"
