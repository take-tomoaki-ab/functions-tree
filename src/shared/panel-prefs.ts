// コード表示エリアの高さ（ユーザーがリサイズした値）の保存・取得。
// 保存先は chrome.storage.local（settings.ts の PAT 保存と同じ方針）。

const SOURCE_PANE_HEIGHT_KEY = 'sourcePaneHeightPx';

const MIN_SOURCE_PANE_HEIGHT_PX = 80;
const MAX_SOURCE_PANE_HEIGHT_PX = 4000;

export async function getSourcePaneHeight(): Promise<number | null> {
  const items = await chrome.storage.local.get(SOURCE_PANE_HEIGHT_KEY);
  const height = items[SOURCE_PANE_HEIGHT_KEY];
  if (
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height < MIN_SOURCE_PANE_HEIGHT_PX ||
    height > MAX_SOURCE_PANE_HEIGHT_PX
  ) {
    return null;
  }
  return height;
}

export async function setSourcePaneHeight(heightPx: number): Promise<void> {
  await chrome.storage.local.set({ [SOURCE_PANE_HEIGHT_KEY]: heightPx });
}
