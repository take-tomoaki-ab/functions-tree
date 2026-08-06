// memo(function ...) ラップ。中の <Row /> は Card ノードに帰属する
import { memo } from 'react';
import { Row } from './row';

export const Card = memo(function CardImpl() {
  return <Row />;
});
