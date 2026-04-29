# Sample App GitOps Demo

This sample app demonstrates an end-to-end GitOps loop for MTI-10:

1. `services/sample-app` is built and pushed to ECR by `.github/workflows/gitops-sample-app.yml`.
2. The same workflow writes the image reference back to `k8s/apps/sample-app/overlays/<env>/kustomization.yaml`.
3. ArgoCD applications in `k8s/argocd-apps/sample-app-*.yaml` auto-sync the new commit into EKS.

## Validation checkpoints

- Deployment health:
  - `kubectl get pods -n sample-app-dev`
  - `kubectl get deployment sample-app-dev -n sample-app-dev`
- Metrics in Grafana/Prometheus:
  - Query `sum(rate(sample_app_http_requests_total[5m])) by (env,status_code)`
  - Query `histogram_quantile(0.95, sum(rate(sample_app_http_request_duration_seconds_bucket[5m])) by (le, env))`
- Logs in Loki:
  - `{service="sample-app", namespace="sample-app-dev"}`

## Notes

- The overlay `newName` fields are automatically updated by GitHub Actions to match `${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/sample-app`.
- Trigger `workflow_dispatch` for staging/prod promotions once dev is validated.
