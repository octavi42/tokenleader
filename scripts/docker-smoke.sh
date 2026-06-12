#!/bin/sh
set -eu
# Deploy-artifact smoke test: the image builds, the container boots non-root,
# and /health answers 200. Run from the repo root.
IMAGE="${SMOKE_IMAGE:-tokenleader-smoke}"
PORT="${SMOKE_PORT:-18787}"
NAME="tokenleader-smoke-$$"

docker build -t "$IMAGE" .
# No TOKENLEADER_GH_REPO/TOKEN in env, so the GitHub mirror stays off.
docker run -d --rm --name "$NAME" \
  -p "127.0.0.1:${PORT}:8787" \
  "$IMAGE"
trap 'docker stop -t 30 "$NAME" >/dev/null 2>&1 || true' EXIT

i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "[smoke] /health 200"
    # pid 1 is the exec'd server; prove the entrypoint dropped privileges.
    uid="$(docker exec "$NAME" stat -c %u /proc/1)"
    if [ "$uid" = "0" ]; then
      echo "[smoke] FAIL: server is running as root" >&2
      exit 1
    fi
    echo "[smoke] server uid=${uid} (non-root)"
    echo "[smoke] OK"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
echo "[smoke] FAIL: /health never answered" >&2
docker logs "$NAME" >&2 || true
exit 1
