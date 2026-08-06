// テスト用フィクスチャ: class コンポーネント（issue #28 F）。
// 親も子も class。render() の呼び出しは class ノードに帰属する。

import { Component } from 'react';
import Panel from './panel';

export class Parent extends Component {
  private title = 'parent';

  helper(): string {
    return this.title;
  }

  render() {
    return <Panel label={this.helper()} />;
  }
}
