export type SplitColumnId = 'left' | 'right';

export interface SplitColumnState {
  folderId?: string;
  search: string;
}

export interface SplitViewState {
  left: SplitColumnState;
  right: SplitColumnState;
}

export type SplitViewAction =
  | { type: 'folder'; column: SplitColumnId; value?: string }
  | { type: 'search'; column: SplitColumnId; value: string };

export function initialSplitState(leftFolderId?: string, rightFolderId?: string): SplitViewState {
  return {
    left: { folderId: leftFolderId, search: '' },
    right: { folderId: rightFolderId, search: '' },
  };
}

export function splitViewReducer(state: SplitViewState, action: SplitViewAction): SplitViewState {
  return {
    ...state,
    [action.column]: action.type === 'folder'
      ? { ...state[action.column], folderId: action.value }
      : { ...state[action.column], search: action.value },
  };
}
