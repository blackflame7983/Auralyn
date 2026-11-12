/** `footer` は右の列の出し分け。名前はフッター時代のまま、条件は変えない。 */
export type HomeChrome =
  | { readonly kind: 'setup'; readonly vstPanel: 'closed' | 'beside' | 'overlay'; readonly footer: { readonly compare: 'whileActive'; readonly outputMeter: true } }
  | { readonly kind: 'daily'; readonly vstPanel: 'closed' | 'beside' | 'overlay'; readonly stage: 'full' | 'yield'; readonly footer: { readonly compare: 'always'; readonly outputMeter: false } };

export function deriveHomeChrome(input: {
  readonly configured: boolean;
  readonly soundExpanded: boolean;
  readonly vstPanel: { readonly present: boolean; readonly open: boolean; readonly wide: boolean };
}): HomeChrome {
  const vstPanel = !input.vstPanel.present || !input.vstPanel.open ? 'closed' : input.vstPanel.wide ? 'beside' : 'overlay';
  if (!input.configured) return { kind: 'setup', vstPanel, footer: { compare: 'whileActive', outputMeter: true } };
  return { kind: 'daily', vstPanel, stage: input.soundExpanded ? 'yield' : 'full', footer: { compare: 'always', outputMeter: false } };
}
