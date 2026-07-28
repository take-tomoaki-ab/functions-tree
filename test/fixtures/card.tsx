// テスト用フィクスチャ: JSX で参照される関数コンポーネント側（named export の 2 形態）。

export function Card({ title, children }: { title: string; children?: unknown }) {
  return (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export const CardTitle = ({ text }: { text: string }) => <h2>{text}</h2>;
