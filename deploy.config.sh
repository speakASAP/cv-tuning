# deploy.config.sh — declaration consumed by shared/scripts/deploy.sh.

SERVICE_NAME="cv-tuning"
PORT="3379"

IMAGES=(
  "cv-tuning|.||"
)

DEPLOYMENTS=(
  "cv-tuning|app|cv-tuning"
)

# No ingress until the GDPR phase; the service must not be publicly reachable before then.
MANIFESTS=(configmap.yaml external-secret.yaml service.yaml deployment.yaml)
