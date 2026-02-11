# API Gateway

A Go-based API gateway that handles authentication, request routing, and middleware chaining. Deployed to Kubernetes using Kustomize for environment-specific overlays.

## Architecture

The gateway uses Go's standard `net/http` with a middleware chain pattern. Authentication is handled via JWT tokens validated by the internal auth package. Handlers are organized by resource type.

## Deployment

Kubernetes manifests use Kustomize with a base configuration and environment-specific overlays (production, staging). The base deployment defines the core service and deployment resources.

## Configuration

Runtime configuration is loaded from environment variables. See `.env.example` for the required variables. The gateway reads `PORT`, `JWT_SECRET`, `LOG_LEVEL`, and upstream service URLs from the environment.

## Development

1. Copy `.env.example` to `.env` and fill in values
2. Run `go run cmd/server/main.go`
3. The gateway starts on the configured port
