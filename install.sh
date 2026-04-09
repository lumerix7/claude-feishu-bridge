#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="claude-feishu-bridge"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="${CONFIG_HOME}/${UNIT_NAME}"
ENV_TEMPLATE="${ROOT_DIR}/deploy/config/bridge.env.example"
JSON_TEMPLATE="${ROOT_DIR}/deploy/config/config.json"
ENV_PATH="${CONFIG_DIR}/bridge.env"
JSON_PATH="${CONFIG_DIR}/config.json"
USER_HOME="${HOME}"
PATH_VALUE="${PATH}"

# Detect OS
OS="$(uname -s)"
case "${OS}" in
  Darwin)
    IS_MACOS=true
    LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
    PLIST_TEMPLATE="${ROOT_DIR}/deploy/com.claude-feishu-bridge.plist"
    PLIST_PATH="${LAUNCH_AGENTS_DIR}/com.${UNIT_NAME}.plist"
    START_SH_TEMPLATE="${ROOT_DIR}/deploy/start.sh"
    START_SH_PATH="${CONFIG_DIR}/start.sh"
    ;;
  Linux)
    IS_MACOS=false
    UNIT_FILE="${UNIT_NAME}.service"
    SYSTEMD_DIR="${CONFIG_HOME}/systemd/user"
    UNIT_TEMPLATE="${ROOT_DIR}/deploy/${UNIT_FILE}"
    UNIT_PATH="${SYSTEMD_DIR}/${UNIT_FILE}"
    ;;
  *)
    echo "ERROR: Unsupported OS: ${OS}" >&2
    exit 1
    ;;
esac

echo "=== ${UNIT_NAME} installer ==="
echo "repo:   ${ROOT_DIR}"
echo "os:     ${OS}"
echo "env:    ${ENV_PATH}"
echo "config: ${JSON_PATH}"
echo "note:   bridge.env holds secrets; config.json holds tuning. Both preserved on update."

# 1. Build
cd "${ROOT_DIR}"
npm install
npm run build

# 2. Global install via npm pack
PACK_FILE="$(npm pack --json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['filename'])")"
GLOBAL_PREFIX="$(npm prefix -g)"
GLOBAL_ROOT="$(npm root -g)"
GLOBAL_PKG_DIR="${GLOBAL_ROOT}/${UNIT_NAME}"
GLOBAL_BIN_DIR="${GLOBAL_PREFIX}/bin"

mkdir -p "${GLOBAL_ROOT}" "${GLOBAL_BIN_DIR}"
rm -rf "${GLOBAL_PKG_DIR}"
mkdir -p "${GLOBAL_PKG_DIR}"
tar -xzf "./${PACK_FILE}" -C "${GLOBAL_PKG_DIR}" --strip-components=1
cp -a node_modules "${GLOBAL_PKG_DIR}/"
ln -sf "${GLOBAL_PKG_DIR}/bin/${UNIT_NAME}.js" "${GLOBAL_BIN_DIR}/${UNIT_NAME}"
chmod +x "${GLOBAL_PKG_DIR}/bin/${UNIT_NAME}.js" "${GLOBAL_BIN_DIR}/${UNIT_NAME}"
rm -f "${PACK_FILE}"

BIN_PATH="$(command -v "${UNIT_NAME}" || true)"
if [[ -z "${BIN_PATH}" ]]; then
  echo "ERROR: ${UNIT_NAME} not found on PATH after install." >&2
  exit 1
fi
echo ">>> installed: ${BIN_PATH}"

# 3. Create config dir; write bridge.env and config.json on first install only
mkdir -p "${CONFIG_DIR}"

if [[ ! -f "${ENV_PATH}" ]]; then
  cp "${ENV_TEMPLATE}" "${ENV_PATH}"
  # Expand $HOME in the env file
  sed -i "s|\$HOME|${USER_HOME}|g" "${ENV_PATH}"
  echo ">>> created ${ENV_PATH} — fill in Feishu credentials before starting."
else
  echo ">>> preserved existing ${ENV_PATH}"
fi

if [[ ! -f "${JSON_PATH}" ]]; then
  python3 - "${JSON_TEMPLATE}" "${JSON_PATH}" "${USER_HOME}" <<'PY'
from pathlib import Path
import json, sys

src, dst, user_home = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
data = json.loads(src.read_text())

def expand(v):
    if isinstance(v, str):  return v.replace("$HOME", user_home)
    if isinstance(v, list): return [expand(i) for i in v]
    if isinstance(v, dict): return {k: expand(i) for k, i in v.items()}
    return v

data = expand(data)
# Set defaultPath and ensure home is in allowedRoots
proj = data.setdefault("project", {})
proj.setdefault("defaultPath", user_home)
roots = proj.setdefault("allowedRoots", [])
if user_home not in roots:
    roots.insert(0, user_home)

dst.write_text(json.dumps(data, indent=2) + "\n")
PY
  echo ">>> created ${JSON_PATH}"
else
  echo ">>> preserved existing ${JSON_PATH}"
fi

# 4. Install service (platform-specific)
if [[ "${IS_MACOS}" == "true" ]]; then
  # macOS: Install launchd service
  mkdir -p "${LAUNCH_AGENTS_DIR}"

  # Create start.sh to load environment variables
  sed \
    -e "s|@ENV_PATH@|${ENV_PATH}|g" \
    -e "s|@BIN_PATH@|${BIN_PATH}|g" \
    "${START_SH_TEMPLATE}" > "${START_SH_PATH}"
  chmod +x "${START_SH_PATH}"
  echo ">>> created ${START_SH_PATH}"

  # Create plist
  sed \
    -e "s|@START_SH_PATH@|${START_SH_PATH}|g" \
    -e "s|@HOME@|${USER_HOME}|g" \
    "${PLIST_TEMPLATE}" > "${PLIST_PATH}"
  echo ">>> created ${PLIST_PATH}"

  # Unload old service if running
  launchctl unload "${PLIST_PATH}" 2>/dev/null || true

  # Load new service
  launchctl load "${PLIST_PATH}"

  echo ""
  echo ">>> verifying service..."
  sleep 2
  launchctl list | grep "${UNIT_NAME}"

  echo ""
  echo "=== Done ==="
  echo "Logs:    /tmp/claude-feishu-bridge.log"
  echo "Config:  ${CONFIG_DIR}/"
  echo ""
  echo "Commands:"
  echo "  stop:   launchctl unload ${PLIST_PATH}"
  echo "  start:  launchctl load ${PLIST_PATH}"
  echo "  status: launchctl list | grep ${UNIT_NAME}"

else
  # Linux: Install systemd user service
  mkdir -p "${SYSTEMD_DIR}"

  sed \
    -e "s|@BIN_PATH@|${BIN_PATH}|g" \
    -e "s|@HOME@|${USER_HOME}|g" \
    -e "s|@PATH@|${PATH_VALUE}|g" \
    "${UNIT_TEMPLATE}" > "${UNIT_PATH}"
  echo ">>> created ${UNIT_PATH}"

  systemctl --user daemon-reload
  systemctl --user enable "${UNIT_FILE}" >/dev/null

  # Graceful restart (kill old process cleanly)
  systemctl --user stop "${UNIT_FILE}" || true
  for _ in $(seq 1 50); do
    if ! systemctl --user is-active --quiet "${UNIT_FILE}"; then break; fi
    sleep 0.2
  done
  systemctl --user kill --signal=SIGKILL "${UNIT_FILE}" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user reset-failed "${UNIT_FILE}" 2>/dev/null || true
  systemctl --user start "${UNIT_FILE}"

  echo ""
  echo ">>> verifying service..."
  systemctl --user is-active "${UNIT_FILE}" >/dev/null
  systemctl --user show "${UNIT_FILE}" -p MainPID -p ActiveState -p SubState -p EnvironmentFiles

  echo ""
  echo "=== Done ==="
  echo "Logs:    journalctl --user -u ${UNIT_NAME} -f"
  echo "Config:  ${CONFIG_DIR}/"
fi
