import { Component } from 'react';
import { Card } from './card';

export default class Panel extends Component<{ label: string }> {
  render() {
    return (
      <div>
        <Card />
      </div>
    );
  }
}
