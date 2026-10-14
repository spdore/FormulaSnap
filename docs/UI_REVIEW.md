# FormulaSnap UI Review

## Review scope

The latest user-approved three-column blue-and-white reference is the product design baseline. Previous concept images are not design references.

The browser-rendered production frontend was reviewed at wide and narrow viewport sizes. Wide layouts show navigation, the central recognition workspace, and the right-side output/settings/history panels. Narrow layouts fold content vertically while retaining navigation and a scrollable main area.

The review led to these changes:

- The “View all” history link now retains its natural text width rather than inheriting the compact icon-button width.
- The primary recognition action sits directly below image preprocessing controls.
- Windows uses a light custom title bar with pin, minimize, maximize/restore, and close controls.
- Scrollbars share a subtle track and rounded thumb. Navigation, form, output, and secondary text sizes were increased for readability.
- Short transitions respect prefers-reduced-motion. Formula source remains monospaced, and previews use KaTeX fonts.
- New installs default to local recognition and explain that the model is bundled. API keys remain in the system credential store.

## Workflow review

The workspace follows the main task sequence: capture, paste, or open an image; preprocess it; recognize the formula; inspect source and preview; then copy or export. Recognition appears next to the image tools, while result actions remain in the output section. The three columns have distinct roles.

The interface uses system UI fonts and KaTeX math fonts. Common controls use approximately 14–16 px text, secondary text remains at least 12 px, and interaction transitions are short. Native animation frame rate has not been measured.

## Acceptance limits

The review used browser rendering. It does not verify native window dragging, resizing, file dialogs, clipboard behavior, keyboard operation, desktop animation smoothness, or screenshot flow. These require manual desktop acceptance. See docs/TESTING.md.
