// forwardRef(arrow) ラップ
import { forwardRef } from 'react';

export const Input = forwardRef((props: { name: string }, ref: unknown) => (
  <input name={props.name} />
));
