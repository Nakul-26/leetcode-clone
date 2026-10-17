# GEMINI.md
# ─────────────────────────────────────────────────────────────
# Project context & usage instructions for Gemini CLI
# Place this file at repo root (or in subfolders for scoped behavior).
# Keep this concise and authoritative — Gemini will incorporate these
# instructions into its reasoning and actions.

## 1) Project overview
Project: LeetCode Clone Platform
Short description: A microservices-based platform for coding assessments. It features a React frontend, a Node.js API for submissions, and a Go-based judge service for code execution and evaluation.
Primary languages: Go, JavaScript (Node.js, React), JSON, Shell, Dockerfile.

Main entrypoints:
- `docker-compose.yml`: Primary entrypoint for running the full application stack.
- `assessment-api/index.js`: Main API entry point (imports from `src/server.js`).
- `judge-service-go/main.go`: The code execution and judging service.
- `frontend/src/main.jsx`: The React frontend application.

## 2) Project Structure
- `assessment-api/`: Node.js Express API.
  - `src/`: Controllers, services, models, routes.
  - `scripts/`: Maintenance and seeding scripts.
- `judge-service-go/`: Go-based code execution service.
  - `pkg/`: Core logic (executor, pool, languages).
  - `environments/`: Dockerfiles for language runtimes.
- `frontend/`: React frontend.
- `contracts/`: JSON schemas for problems and submissions.
- `scripts/`: Top-level utility and testing scripts.
  - `tests/`: Legacy and specialized test scripts.

## 3) Primary goals for the assistant
- Act as a developer-assistant: help diagnose failing tests, write/modify code, refactor services, and suggest PR-ready diffs.
- When asked to propose changes, always produce small incremental patches and include tests.
- Prefer code that is readable and idiomatic to the repo's language and existing patterns.
- Maintain the modularity and separation of concerns across microservices.

## 4) Persona & constraints
Persona: "Practical senior engineer — concise, precise, and test-first."
Tone: Short, actionable instructions and code comments.
Hard constraints:
- Do not commit secrets or API keys.
- Do not change behavior of production-critical scripts or configurations unless requested.
- When editing files, always include a short commit message and a one-line rationale.

## 5) Coding style (repo-specific)
- **Go (`judge-service-go`):** Follow standard Go conventions. Use `go fmt` and `go vet`.
- **Node.js (`assessment-api`):** Use ES Modules (`.mjs` or `type: module`). Follow existing patterns for async/await.
- **React (`frontend`):** Adhere to the ESLint rules in `frontend/eslint.config.js`. Use functional components with hooks.
- **General:** Keep functions focused on a single responsibility. Extract helpers for repeated logic.

## 6) Test / verification workflow
When proposing a change:
1. Identify and run relevant tests:
    - **Frontend:** `cd frontend && npm test`
    - **Go Judge Service (Unit):** `cd judge-service-go && go test ./...`
    - **Go Judge Service (Integration):** `cd judge-service-go && go test -v -tags=integration .` (requires Docker)
    - **E2E tests:** `npm run test:submission:docker` (runs the full harness in the compose network)
2. If new logic is added, include corresponding unit or integration tests.
3. Run linters and formatters:
    - **Frontend:** `cd frontend && npm run lint`
    - **Go Judge Service:** `cd judge-service-go && make fmt && make vet`
4. Before finalizing, ensure the entire application builds and runs with `docker-compose build` and `docker-compose up`.

## 7) Files & folders to avoid touching unless explicitly requested
- `.github/` (CI/CD workflows)
- `.devcontainer/` (Development environment setup)
- `node_modules/`, `dist/`, `tmp/`
- Any file containing `# DO NOT EDIT`.
- `.env`, `secrets/`, `credentials/*`.

## 8) Git & commit conventions
- Commit message prefix: `fix:`, `feat:`, `chore:`, `test:`, `refactor:`, `docs:`
- Provide a one-line summary. Add a 2–3 line body for non-trivial changes explaining the 'why'.

## 9) Troubleshooting & debug info
When reporting a bug, include:
- Service name (e.g., `assessment-api`, `judge-service-go`).
- Exact failing command and full logs (`docker-compose logs <service_name>`).
- Output of `docker ps`.

## 10) Dev environment hot-reload behavior
- **Assessment API (Node.js):** Uses `node --watch` (`npm run dev`). Auto-reloads on file changes.
- **Judge Service (Go):** Uses `air` for hot reload. Auto-reloads on file changes.
- **Frontend (React):** Automatically reloads via Vite dev server.

Assistant rule: Do not suggest restarting these services unless the change affects Docker builds or environment configuration.

## 11) Stability rule
- Do not modify code that is already working correctly unless explicitly requested.
- Changes should be targeted, incremental, and safe.

# End of GEMINI.md
