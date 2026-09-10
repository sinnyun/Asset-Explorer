# Resizable Sidebars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow the left navigation sidebar and right properties panel to be resized horizontally by dragging their boundaries, with bounded widths persisted locally.

**Architecture:** Add a small reusable resize hook that tracks pointer movement through `document` listeners and clamps the width to panel-specific bounds. `App` owns the two widths and applies them as inline styles to the existing three-column layout; persistence uses `localStorage` only and does not touch data or query state.

**Tech Stack:** React hooks, TypeScript, Tailwind utility classes, browser Pointer Events and localStorage.

## Global Constraints

- Left sidebar width is clamped to 240–520px.
- Right properties panel width is clamped to 280–560px.
- Existing default widths remain unchanged.
- Dragging must not trigger asset/folder queries or mutate application data.
- The resize affordance must be keyboard-safe to the extent supported by the existing layout and must expose an accessible label.

---

### Task 1: Define tested width and persistence behavior

**Files:**
- Create: `src/services/panelLayout.ts`
- Test: `tests/asset-query.test.ts`

**Interfaces:**
- Produce `PanelLayoutKey`, `PanelLayout`, `clampPanelWidth(value, min, max)`, `readPanelLayout(storage)`, and `writePanelLayout(storage, layout)`.

- [ ] **Step 1: Write failing tests** for clamping below/above bounds, rejecting invalid stored values, and round-tripping valid widths.
- [ ] **Step 2: Run `npm run test:ts` and confirm the new tests fail because the module does not exist.
- [ ] **Step 3: Implement the minimal typed helper with safe JSON parsing and fallback defaults.
- [ ] **Step 4: Run the focused and full TypeScript tests; confirm they pass.

### Task 2: Add pointer-driven resize hook

**Files:**
- Create: `src/hooks/useResizablePanel.ts`
- Test: `tests/asset-query.test.ts`

**Interfaces:**
- Produce `useResizablePanel({ direction, width, minWidth, maxWidth, onWidthChange })` for left/right panel resize handles.

- [ ] **Step 1: Add a pure testable drag calculation helper and failing tests for left and right directions plus clamping.
- [ ] **Step 2: Run the focused tests and confirm failure.
- [ ] **Step 3: Implement the hook with pointer capture, document-level move/up listeners, and cleanup on unmount.
- [ ] **Step 4: Run the TypeScript tests and confirm the new behavior passes.

### Task 3: Integrate both handles into the application shell

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consume the panel layout helpers and resize hook.
- Render one handle after `Sidebar` and one handle before `PropertiesPanel`.

- [ ] **Step 1: Add left/right width state initialized from persisted layout with existing widths as defaults.
- [ ] **Step 2: Apply widths only to the two side panels and add accessible resize handles with `role="separator"`.
- [ ] **Step 3: Persist width changes after drag completion and add visual hover/drag affordances.
- [ ] **Step 4: Confirm the central `MainArea` remains flexibly sized and no query dependencies are changed.

### Task 4: Verify and commit

**Files:**
- Verify: `src/App.tsx`, `src/hooks/useResizablePanel.ts`, `src/services/panelLayout.ts`, `tests/asset-query.test.ts`

- [ ] **Step 1: Run `npm run lint`.
- [ ] **Step 2: Run `npm run test:ts`.
- [ ] **Step 3: Run `npm run build`.
- [ ] **Step 4: Check `git diff --check` and `git status --short`.
- [ ] **Step 5: Commit with `feat: add resizable sidebars`.
