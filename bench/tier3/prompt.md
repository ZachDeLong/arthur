frontend/src/App.tsx is 899 lines and handles too many concerns in a single file —
theme management, settings persistence, filter state with URL sync, data fetching,
pagination, keyboard shortcuts, and multiple modal/inline components.

Decompose App.tsx into focused, well-separated hooks and components. Use your
judgment on what to extract and how to organize it. App.tsx should remain as the
top-level layout orchestrator but delegate its concerns to the new modules.

Requirements:
- All existing functionality must be preserved (no visual or behavioral changes)
- `cd frontend && npm run build` must pass after refactoring
- New hooks go in frontend/src/hooks/, new components in frontend/src/components/
- Do not modify the existing useBookmarks or useReadingLists hooks
