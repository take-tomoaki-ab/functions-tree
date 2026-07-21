// PAT の保存・取得・削除。options ページと background の双方から使う。
// 保存先は chrome.storage.local（プラン確定事項。sync には載せない）。

/** chrome.storage.local 上のキー。storage.onChanged で PAT の設定変更を検知する用途にも使う */
export const PAT_KEY = 'githubPat';

export async function getPat(): Promise<string | null> {
  const items = await chrome.storage.local.get(PAT_KEY);
  const pat = items[PAT_KEY];
  return typeof pat === 'string' && pat.length > 0 ? pat : null;
}

export async function setPat(pat: string): Promise<void> {
  await chrome.storage.local.set({ [PAT_KEY]: pat });
}

export async function clearPat(): Promise<void> {
  await chrome.storage.local.remove(PAT_KEY);
}
