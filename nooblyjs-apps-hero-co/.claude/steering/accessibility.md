# Accessibility (roadmap 8.4)

The bar is stack.md §5: WCAG 2.2 AA, 44 px touch targets, the 2 px persimmon focus outline, status in words as well
as colour, `prefers-reduced-motion`, and every screen at phone width.

## What is tested

`test/ui/a11y.spec.js` (Playwright, desktop and phone, part of `npm run test:ui` and CI):

- **axe-core, WCAG 2.2 A and AA rules,** on every screen once it has drawn: the signed-out pages (home, forgot and
  reset password, verify email, invitation, nooblyjs-core's sign-in page), every workspace page, the create form of
  each service type, a service page of each type in the seeded workspace, and the operator screens (back office,
  NooblyJS Pay, infrastructure). Any violation fails with the screen, the rule and the first element.
- **44 px targets on a phone:** every link, button, field, tab and switch on the main screens measures at least 44 px
  each way. A link inside a sentence is exempt, as WCAG 2.5.8 allows.

## Found and fixed (2026-11-23)

| Rule | Where | Fix |
| --- | --- | --- |
| Links told apart by colour only (1.4.1) | Links inside sentences on the service picker and service pages (1.6:1 against the text) | Links in running text are underlined (the theme takes underlines off every link) |
| Contrast (1.4.3) | The log viewer's header line: the light theme's muted grey on the dark viewer (2.7:1) | The on-dark muted token (about 10:1) |
| Scrollable region not reachable by keyboard (2.1.1) | Tables that scroll sideways on a phone; the build and run logs | Each is a named region with `tabindex="0"`, with a focus ring |
| Targets under 44 px (stack.md §5) | Buttons and tabs (41 px), link buttons, service names on cards, names in tables, the public bar, the Auto-deploy switch | On touch screens (`pointer: coarse`), 44 px minimum height and width; the switch's whole row is its label |

Already in place: the skip link, the focus outline, `prefers-reduced-motion`, statuses in words, labelled fields.

## Checked by hand (axe cannot)

Keyboard paths through sign-up, create a service, and the service page; screen-reader names of the status pill,
meters and log viewer. Do these again when a screen changes much.

## Dark mode (2026-11-23)

- **Who gets it:** dark when the device is set to dark, light otherwise; *Settings → Appearance* (System / Light /
  Dark) overrides it for that browser and is remembered. `public/js/theme.js`, a classic script in `<head>`, sets
  `data-bs-theme` before the page draws, so it never flashes.
- **The palette** (`public/css/hero-co.css`, `:root[data-bs-theme="dark"]`): the theme has no dark values, so each of
  its colour tokens gets one there. Warm brown-black grounds and cream text, not a cold console; persimmon stays the
  fill behind white text, a lighter persimmon is used for links and accents on dark.
- **The log viewer** keeps its own tokens (`--nj-log-*`) and is dark in both modes, a shade darker than the page in
  dark mode.
- **Checked:** the same axe tests run in dark mode (every screen, desktop and phone), and a test checks that System
  follows the device, that Light and Dark stay after a reload, and that the log viewer is dark in both.
- **Not dark:** nooblyjs-core's sign-in page and the operator screens (the accelerators' own styles).

Found on the way: the Auto-deploy switch was drawn as a stretched checkbox in both modes (it was not inside Bootstrap's
`form-switch`); it is a switch now.
