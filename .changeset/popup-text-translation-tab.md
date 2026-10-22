---
"@read-frog/extension": patch
---

feat(popup): add a text translation tab to the popup

The translation hub — paste text, pick languages, ask several providers at once —
used to live only on its own page, so translating a sentence meant opening a new
browser tab. The popup now has two tabs: the page controls it always had, and a
Text tab that carries the hub's input, language pickers, provider selection and
per-provider result cards, stacked for the popup's width.

It is the same code as the hub, not a second implementation: the atoms, the
provider selection, the cards and their copy/speak actions are the hub's own
components, so the two views cannot drift apart. Only the layout differs — one
column, compact language labels ("英语" rather than "英语 (English)"), and a
scrolling results list so the input stays in place while a long translation is
read.

The popup remembers which tab was open in a `storage.local` key of its own, so
it reopens where it was left. No config field is added, and therefore no schema
bump or migration: the page view stays the default for anyone who has never
switched, which is what the popup showed before.
