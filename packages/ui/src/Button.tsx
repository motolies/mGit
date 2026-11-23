import type { ButtonHTMLAttributes, Ref } from 'react';
import styles from './Button.module.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 강조 버튼 여부. 기본은 보조 버튼 */
  variant?: 'primary' | 'secondary';
  /** 버튼 요소 (대화상자가 열릴 때 포커스를 줄 단추 등) */
  ref?: Ref<HTMLButtonElement>;
}

/** 공용 버튼. 툴바·대화상자에서 같은 모양을 쓰기 위한 얇은 래퍼 */
export function Button({ variant = 'secondary', className, ...rest }: ButtonProps) {
  const classes = [styles.button, variant === 'primary' ? styles.primary : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <button type="button" className={classes} {...rest} />;
}
