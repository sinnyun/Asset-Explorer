export const PANEL_LAYOUT_STORAGE_KEY = 'assethub.panel-layout';

export interface PanelLayout {
  leftWidth?: number;
  rightWidth?: number;
}

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function clampPanelWidth(value: number, minWidth: number, maxWidth: number): number {
  if (!Number.isFinite(value)) return minWidth;
  return Math.min(maxWidth, Math.max(minWidth, Math.round(value)));
}

export function readPanelLayout(storage: StorageLike | null | undefined): PanelLayout {
  if (!storage) return {};
  try {
    const raw = storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const layout: PanelLayout = {};
    if (typeof parsed.leftWidth === 'number' && Number.isFinite(parsed.leftWidth) && parsed.leftWidth > 0) {
      layout.leftWidth = parsed.leftWidth;
    }
    if (typeof parsed.rightWidth === 'number' && Number.isFinite(parsed.rightWidth) && parsed.rightWidth > 0) {
      layout.rightWidth = parsed.rightWidth;
    }
    return layout;
  } catch {
    return {};
  }
}

export function writePanelLayout(storage: StorageLike | null | undefined, layout: PanelLayout): void {
  if (!storage) return;
  try {
    storage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage may be unavailable in restricted webviews; layout remains in memory.
  }
}
