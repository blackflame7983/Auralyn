/** `footer` は右の列の出し分け。名前はフッター時代のまま、比較の条件は変えない。 */
export type HomeChrome =
  | { readonly kind: 'setup'; readonly footer: { readonly compare: 'whileActive' } }
  | { readonly kind: 'daily'; readonly footer: { readonly compare: 'always' } };

export function deriveHomeChrome(input: { readonly configured: boolean }): HomeChrome {
  if (!input.configured) return { kind: 'setup', footer: { compare: 'whileActive' } };
  return { kind: 'daily', footer: { compare: 'always' } };
}
