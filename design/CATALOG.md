# Design catalog — what VZ-DESIGN-001 adds

**Design source.** The accepted Figma library "Vizra — Design System" (file key
`JXgRItauynmT0g8vSJB3oR`), as recorded under `docs/design/` in the meta
repository (`docs/design/figma/README.md` §2–§4, §8), **design revision
2026-09-20, accepted by the owner 2026-11-10**. Nothing here is taken from any
other source; a value the design does not define is not in this slice.

State: IMPLEMENTED, READY_FOR_REVIEW. Not VERIFIED — that needs an independent
verifier.

## Tokens — `design/tokens.css`

133 custom properties, all `--vz-*`, in Figma's own web code syntax
(`color/ink-2` → `--vz-ink-2`). Semantic roles only; the primitives ramp is
not emitted. Wired into Tailwind in `app/globals.css` (`@theme inline`, with
Tailwind's default colour, radius, shadow and text scales reset so only token
utilities exist). Checked by `design/tokens.test.ts`.

| Group | Prefix | Count |
| --- | --- | --- |
| Surfaces | `--vz-bg*` | 8 |
| Text | `--vz-ink*` | 6 |
| Rules | `--vz-line*` | 4 |
| Accent | `--vz-accent*` | 10 |
| Status | `--vz-danger*` 10, `--vz-success*` 6, `--vz-warn*` 6 | 22 |
| On-colour text | `--vz-on*` | 12 |
| Focus, scrim | `--vz-focus*`, `--vz-scrim*` | 4 |
| Elevation, shadow | `--vz-elevation*`, `--vz-shadow*` | 9 |
| Type | `--vz-font*` 2, `--vz-type*` 27 | 29 |
| Space, size | `--vz-space*` 11, `--vz-size*` 7 | 18 |
| Radius, stroke | `--vz-radius*` 5, `--vz-stroke*` 3 | 8 |
| Motion | `--vz-motion*` | 3 |

Themes: light on `:root`; dark redefines the 36 colour roles for
`:root[data-theme="dark"]` and for `prefers-color-scheme: dark` unless
`data-theme="light"` is set.

## Components

| Component | File | Design node | Notes |
| --- | --- | --- | --- |
| `AppShell` | `components/shell/AppShell.tsx` | — | One banner, one `main#content`; mounted in `app/layout.tsx`. |
| `SkipLink` | `components/shell/SkipLink.tsx` | — | First Tab stop; moves focus to `main`. |
| `TopBar` | `components/shell/TopBar.tsx` | `TopNav / M1` `30:770`, `AppBar / M1` `30:814` | Wordmark only (see below). |
| `Icon` | `components/icons/Icon.tsx` | — | `<Icon name="…" />`; `name` is a key of the registry, checked by the compiler. |

## Icons — `components/icons/registry.ts`

One family: `lucide-react` pinned exactly at 1.46.0 (ISC). 40 semantic names,
each a static named import of the package's canonical export, re-checked
against the installed package by `components/icons/registry.test.ts`;
`components/icons/icon.typecheck.tsx` makes an unknown name a compile error.

`upload`, `favorite`, `rating`, `comment`, `add-to-album`, `share`,
`download`, `report`, `delete`, `search`, `filter`, `visibility-public`,
`visibility-unlisted`, `visibility-private`, `visibility-password`,
`settings`, `notifications`, `close`, `back`, `previous`, `next`, `expand`,
`zoom-in`, `zoom-out`, `confirm`, `loading`, `info`, `warning`, `success`,
`error`, `photo`, `albums`, `storage`, `sign-out`, `hidden`, `retry`, `more`,
`person`, `home`, `edit`.

One deviation from the design, forced by the package: the design names
`Trash2` for delete; in 1.46.0 that is only an alias of `Trash`, so the
registry imports `Trash`.

## Security headers — `lib/security/headers.ts`

Not a design artefact, shipped in the same slice: an enforcing nonce-based
`Content-Security-Policy` (applied per request by `proxy.ts`), and
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` on every
path (`next.config.ts`). No ADR defines these; the source is the war-room
follow-up row "security F3".

## What the design did not determine, and what was left out

- **No theme control is drawn.** The tokens honour `data-theme` and the system
  preference; nothing in the UI sets `data-theme` yet.
- **Signed-in and signed-out navigation is left out.** The design draws
  Library, Albums, Upload, the account menu, "Create account" and "Sign in";
  none of `/library`, `/albums`, `/upload`, `/settings`, `/login`, `/signup`
  exists, and a link to a 404 is a dead control. Each arrives with the slice
  that builds its destination. The wordmark therefore goes to `/`.
- **The brand mark** is a separately reviewed asset that does not exist; the
  wordmark is the string only.
- **The two shell links are plain anchors**, not `next/link`: a client-side
  transition intermittently cancels its own RSC request, which the browser
  lane reports as a failed request. To revisit with the first route that
  needs client-side transitions.
- **`design/HANDOFF.md`** is referenced by comments in `design/tokens.css` and
  `components/icons/registry.ts` (per-node references, and what was not
  mirrored) and has not been written. Owed.

## UI components — `components/ui/` (VZ-DESIGN-001 remainder, PR #13)

Node ids and the full per-component status are in `design/HANDOFF.md` §2.
Hover/Pressed/Focus are CSS states built from tokens (`hover:`, `active:`,
`focus-visible:outline-focus-ring` + offset 2); Disabled/Loading/Error are
props. Tests: `components/ui/components.test.ts`.

| Component | Figma | File | Variants (prop) | States |
| --- | --- | --- | --- | --- |
| Button | `7:146` | `components/ui/Button.tsx` | `kind`: primary, secondary, quiet, danger; `leadingIcon` | default, hover, pressed, focus-visible, disabled (`disabled`), loading (`loading` → `aria-busy`, disabled, stable name, reduced-motion spinner) |
| IconButton | `8:104` | `components/ui/IconButton.tsx` | `kind`: secondary, quiet, danger, onMedia (dual focus ring); `pressed` → `aria-pressed` | default, hover, pressed, focus-visible, disabled; 44px hit box, required `label` → `aria-label` |
| TextField | `9:42` | `components/ui/TextField.tsx` | — | default, hover, focus-visible, error (`error` → `aria-invalid`, icon + text, `aria-describedby`), disabled; visible `<label>`, `helper` |
| Textarea | `9:83` | `components/ui/Textarea.tsx` | — | default, hover, focus-visible, error (`aria-invalid`, icon + text, `aria-describedby`), disabled; visible `<label>`, `helper` |

Not yet built (PLANNED): Select, Checkbox, Radio, Switch, Chip, Tab,
PhotoCard, Avatar, TabBar Item/TabBar, Dialog, Toast/Inline status, Banner,
Skeleton, EmptyState, ErrorState. Brand mark: not defined in the accepted
design (HANDOFF §3).
