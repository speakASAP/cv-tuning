# deploy.config.sh — declaration consumed by shared/scripts/deploy.sh.

SERVICE_NAME="cv-tuning"
PORT="3379"

IMAGES=(
  "cv-tuning|.||"
  "cv-tuning-frontend|.|frontend/Dockerfile|"
)

DEPLOYMENTS=(
  "cv-tuning|app|cv-tuning"
  "cv-tuning-frontend|frontend|cv-tuning-frontend"
)

MANIFESTS=(configmap.yaml external-secret.yaml service.yaml deployment.yaml frontend-service.yaml frontend-deployment.yaml ingress.yaml)

deploy_post_verify() {
  local attempt
  for attempt in $(seq 1 10); do
    if curl --fail --silent --show-error --max-time 10 https://cv.alfares.cz/ >/dev/null; then
      echo "Public CV frontend is reachable."
      return 0
    fi
    sleep 3
  done
  echo "CV frontend did not become reachable through cv.alfares.cz after rollout." >&2
  return 1
}
