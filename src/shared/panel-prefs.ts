// サイドペイン（関数詳細等）の幅（ユーザーがドラッグでリサイズした値）の保存・取得。
// 保存先は chrome.storage.local（settings.ts の PAT 保存と同じ方針）。

const SIDE_PANE_WIDTH_KEY = 'sidePaneWidthPx';

const MIN_SIDE_PANE_WIDTH_PX = 200;
const MAX_SIDE_PANE_WIDTH_PX = 2000;

export async function getSidePaneWidth(): Promise<number | null> {
  const items = await chrome.storage.local.get(SIDE_PANE_WIDTH_KEY);
  const width = items[SIDE_PANE_WIDTH_KEY];
  if (
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width < MIN_SIDE_PANE_WIDTH_PX ||
    width > MAX_SIDE_PANE_WIDTH_PX
  ) {
    return null;
  }
  return width;
}

export async function setSidePaneWidth(widthPx: number): Promise<void> {
  await chrome.storage.local.set({ [SIDE_PANE_WIDTH_KEY]: widthPx });
}
