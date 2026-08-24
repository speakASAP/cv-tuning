#!/usr/bin/env bash
# Publishes cv-tuning's workflow definitions to the ConfigMap that
# business-process-control-plane mounts at BPCP_WORKFLOW_SEED_DIR.
#
# cv-tuning owns these documents; BPCP only consumes them. Run this after editing anything in
# docs/workflows/, then restart BPCP — the registry loads seeds once, at construction.
set -euo pipefail

NAMESPACE="${NAMESPACE:-statex-apps}"
CONFIGMAP="${CONFIGMAP:-bpcp-workflow-seeds}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docs/workflows"

shopt -s nullglob
files=("$DIR"/*.workflow.json)
if [ ${#files[@]} -eq 0 ]; then
  echo "no *.workflow.json under $DIR; refusing to publish an empty ConfigMap" >&2
  exit 1
fi

# Every document is parsed before it is published: a malformed one fails BPCP's boot, so it
# must never leave this machine.
for file in "${files[@]}"; do
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$file"
done

args=()
for file in "${files[@]}"; do
  args+=(--from-file="$(basename "$file")=$file")
done

kubectl create configmap "$CONFIGMAP" -n "$NAMESPACE" "${args[@]}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "published ${#files[@]} workflow definition(s) to $CONFIGMAP in $NAMESPACE"
echo "restart BPCP to load them: kubectl rollout restart deploy/business-process-control-plane -n $NAMESPACE"
