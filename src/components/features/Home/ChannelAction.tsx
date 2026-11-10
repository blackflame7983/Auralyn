import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

declare const actionWordBrand: unique symbol;
export type ActionWord = string & { readonly [actionWordBrand]: true };

export function actionWord(text: string): ActionWord {
  if (text.trim() === '') throw new Error('action word is blank');
  return text as ActionWord;
}

type ChannelActionProps = {
  word: ActionWord;
  icon?: ReactNode;
  /** 操作名とは別の、ボタン内に残す値。マイク音量のパーセント。 */
  detail?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

export const ChannelAction = forwardRef<HTMLButtonElement, ChannelActionProps>(function ChannelAction({ word, icon, detail, className, type = 'button', ...rest }, ref) {
  return (
    <Button ref={ref} type={type} variant="outline" size="sm" className={cn('home-action shrink-0 gap-1.5', className)} {...rest}>
      {icon}
      {word}
      {detail}
    </Button>
  );
});
