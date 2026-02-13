The frontend has an inconsistent API layer. Some calls go through `utils/api.ts`,
others use raw `fetch()` (like `usePapers.ts`). Several endpoints have no
TypeScript types (`/api/trends`). Error handling is spotty.

Unify all API calls through a single typed client with complete TypeScript
interfaces for every endpoint response. Infer response shapes from the Flask
backend (`app.py`).

Requirements:
- All HTTP calls routed through the API client (no raw fetch in hooks/components)
- TypeScript interfaces for every endpoint's response shape, inferred from `app.py`
- Consistent error handling pattern across all calls
- `cd frontend && npm run build` must pass
- Preserve all existing functionality
