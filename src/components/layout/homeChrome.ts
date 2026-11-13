/** `footer` は右の列の出し分け。名前はフッター時代のまま、比較の条件は変えない。 */
export type HomeChrome =
  | { readonly kind: 'setup'; readonly vstPanel: 'closed' | 'beside' | 'overlay'; readonly footer: { readonly compare: 'whileActive' } }
  | { readonly kind: 'daily'; readonly vstPanel: 'closed' | 'beside' | 'overlay'; readonly footer: { readonly compare: 'always' } };

export function deriveHomeChrome(input: {
  readonly configured: boolean;
  readonly vstPanel: { readonly present: boolean; readonly open: boolean; readonly wide: boolean };
}): HomeChrome {
  const vstPanel = !input.vstPanel.present || !input.vstPanel.open ? 'closed' : input.vstPanel.wide ? 'beside' : 'overlay';
  if (!input.configured) return { kind: 'setup', vstPanel, footer: { compare: 'whileActive' } };
  return { kind: 'daily', vstPanel, footer: { compare: 'always' } };
}
