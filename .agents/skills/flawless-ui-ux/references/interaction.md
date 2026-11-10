# Interaction

Use for affected controls, state changes, and accessibility questions. Reuse established working primitives.

## Controls and feedback

Use links for navigation and buttons for actions. Give controls names that predict the result. Add icons where their meaning helps; reserve directional arrows for actual movement, disclosure, or a useful destination distinction.

Keep object actions near their object. Show the result where it is expected, and update stale feedback when a new action occurs. Errors should explain recovery without discarding useful input. Disable only what cannot be used during a pending action. Do not fabricate loading or failure paths for a synchronous local action.

Use appropriate inputs, visible labels, associated hints/errors, autocomplete, and keyboard hints. Announce important status changes without repeatedly interrupting reading or moving focus.

## Keyboard and semantics

Check logical reading and focus order, visible focus, keyboard activation, and a sensible location after changes. Essential actions must work beyond hover.

Prefer native elements or reliable existing components for dialogs, menus, and tabs. Keep exposed and visual state consistent. For a modal, ensure focus enters appropriately, remains within it while open, and returns sensibly on dismissal; preserve Escape behavior where applicable. Closed mobile navigation must not remain in the keyboard path. Check the desktop/mobile transition as well as the drawer itself.

Decorative icons should not create repetitive accessible names. Meaningful images need suitable text alternatives.

## Accessibility acceptance

Apply relevant WCAG 2.2 A/AA requirements within the intervention. Verify actual states rather than inferring compliance from attributes or CSS intentions.

- **Contrast:** measure actual foreground/background pairs using Craft. Meaningful authored control/state/graphic information generally needs 3:1 against adjacent colors, subject to [non-text contrast exceptions](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). Decorative borders do not all carry this requirement.
- **Focus:** operate the affected path and ensure sticky regions or overlays do not entirely obscure focus. See [focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html).
- **Targets:** check the 24 by 24 CSS px minimum or applicable spacing/other exception; use more generous targets where suitable. See [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- **Text and layout:** check text resizing to 200% and vertical-content reflow at 320 CSS px where applicable; retain local scrolling for genuinely two-dimensional content. See [resize text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html) and [reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).
- **Spacing overrides:** test applicable user-set line height, paragraph, letter, and word spacing without content loss. These test overrides are not authored defaults. See [text spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html).

Check recovery and reduced-motion behavior where the changed interaction needs them. Report exact observations and gaps; neither this list nor a source scan establishes full conformance.
