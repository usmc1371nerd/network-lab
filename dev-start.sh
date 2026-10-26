#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_pids=()

if [[ -x "$project_root/.venv/bin/python" ]]; then
  python_exe="$project_root/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  python_exe="$(command -v python3)"
else
  echo "[Network Lab] Python 3 is required." >&2
  exit 1
fi

for dependency in node npm setsid; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "[Network Lab] Missing command: $dependency (setsid is provided by util-linux)." >&2
    exit 1
  fi
done

port_listening() {
  "$python_exe" - "$1" <<'PY'
import socket
import sys

try:
    with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=0.2):
        pass
except OSError:
    sys.exit(1)
PY
}

cleanup() {
  trap - EXIT INT TERM
  for pid in "${service_pids[@]}"; do
    # Each service has its own process group, including any child processes.
    kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for pid in "${service_pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_service() {
  local name="$1" port="$2" directory="$3"
  shift 3
  if port_listening "$port"; then
    echo "[$name] Port $port is already listening; leaving that service running."
    return
  fi

  (cd -- "$directory" && exec setsid "$@") &
  local pid=$! attempt
  service_pids+=("$pid")
  for ((attempt = 0; attempt < 100; attempt++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[$name] Startup failed; see the output above." >&2
      return 1
    fi
    if port_listening "$port"; then
      echo "[$name] Ready at http://localhost:$port"
      return
    fi
    sleep 0.1
  done
  echo "[$name] Timed out waiting for port $port." >&2
  return 1
}

if ! "$python_exe" -c 'import flask, flask_cors' 2>/dev/null; then
  echo "[Backend] Install dependencies first: $python_exe -m pip install -r \"$project_root/requirements.txt\"" >&2
  exit 1
fi
if [[ ! -f "$project_root/frontend/node_modules/vite/bin/vite.js" ]]; then
  echo "[Frontend] Install dependencies first: cd \"$project_root/frontend\" && npm ci" >&2
  exit 1
fi

echo "[Network Lab] Starting services..."
# Disable Flask's child-process reloader so service shutdown remains predictable.
start_service Backend 5000 "$project_root/backend" \
  "$python_exe" -m flask --app app run --debug --no-reload --host 127.0.0.1 --port 5000
start_service Frontend 3000 "$project_root/frontend" \
  npm run dev -- --host 127.0.0.1 --port 3000 --strictPort

if ((${#service_pids[@]} > 0)); then
  echo "[Network Lab] Open http://localhost:3000. Press Ctrl+C to stop services started here."
  # If either service exits, clean up the other and propagate its exit status.
  wait -n "${service_pids[@]}"
else
  echo "[Network Lab] Both ports are already listening. Open http://localhost:3000."
fi
