# Design handoff record — VZ-DESIGN-001

This is the ledger's `evidence_required` for VZ-DESIGN-001: every design
artifact mirrored into this repository, with its Figma node reference and the
file that implements it. Node ids are **copied** from the meta repository's
`docs/design/figma/README.md` (§1 page map, §2 collections, §5 components,
§7 icons) and `docs/design/figma/FIRST-SLICE-auth-system.md`; none was
invented. Where the source records no node id, the row says so.

| | |
|---|---|
| Figma file | <https://www.figma.com/design/JXgRItauynmT0g8vSJB3oR> |
| File key | `JXgRItauynmT0g8vSJB3oR` |
| Design revision | `2026-09-20` |
| Accepted | by the owner, 2026-11-10 (meta `docs/warroom/OWNER-DECISIONS.md` 2026-11-10 #1) |

State: IMPLEMENTED, READY_FOR_REVIEW — not VERIFIED.

## 1. Tokens — `design/tokens.css`, wired in `app/globals.css`

| Group | Figma source | Modes | Repo |
|---|---|---|---|
| Colour primitives | collection `Primitives` `VariableCollectionId:2:2`, mode `Value` (`2:0`) | — | **not mirrored** by design (§8: primitives are not emitted) |
| Semantic colour (36 roles) | collection `Color` `VariableCollectionId:2:51` | `Light` (`2:1`), `Dark` (`2:2`) | `design/tokens.css` `:root`, `:root[data-theme="dark"]`, `prefers-color-scheme: dark` |
| Spacing, radii, strokes, sizes, type metrics, motion, fonts | collection `Scale` `VariableCollectionId:3:2`, mode `Value` (`3:0`) | — | `design/tokens.css` (`--vz-space-*`, `--vz-radius-*`, `--vz-stroke-*`, `--vz-size-*`, `--vz-type-*`, `--vz-motion-*`, `--vz-font-*`) |
| Text styles (11, §3.1) | text styles `text/Display` … `text/Mono`, `brand/Wordmark (placeholder)` — NO NODE ID recorded per style | — | `app/globals.css` `--text-*` |
| Effect styles (3, §3.2) | `elevation/1`–`elevation/3` — NO NODE ID recorded per style | — | `--vz-elevation-*`, `app/globals.css` `--shadow-1..3` |
| Focus-visible (§4) | Foundations page `4:19` — rule, no separate node | — | `app/globals.css` `:focus-visible`; `components/ui/Button.tsx` `FOCUS_RING_CLASS` |
| `Meter fit (fill width)` | §8.1 **DO NOT MIRROR INTO CODE** | — | deliberately absent |

## 2. Components

| Component | Figma node | Page | Variant properties (design) | Repo | Status |
|---|---|---|---|---|---|
| `Button` | `7:146` | `4:21` | `Kind` Primary\|Secondary\|Quiet\|Danger; `State` Default\|Hover\|Pressed\|Focus\|Disabled\|Loading; `Leading icon`, `Icon`, `Label` | `components/ui/Button.tsx` | IMPLEMENTED |
| `IconButton` | `8:104` | `4:22` | `Kind` Secondary\|Quiet\|Danger\|On media; `State` Default\|Hover\|Pressed\|Focus\|Disabled; `Icon` | `components/ui/IconButton.tsx` | IMPLEMENTED |
| `TextField` | `9:42` | `4:23` | `State` Default\|Hover\|Focus\|Error\|Disabled | `components/ui/TextField.tsx` | IMPLEMENTED |
| `Textarea` | `9:83` | `4:23` | same as TextField | `components/ui/Textarea.tsx` | IMPLEMENTED |
| `Select` | `9:139` | `4:23` | same as TextField | `components/ui/Select.tsx` | IMPLEMENTED |
| `Checkbox` | `10:66` | `4:24` | `Checked` Off\|On\|Mixed; `State` Default\|Hover\|Focus\|Disabled | `components/ui/Checkbox.tsx` | IMPLEMENTED |
| `Radio` | `10:103` | `4:24` | `Checked` Off\|On; `State` Default\|Hover\|Focus\|Disabled | `components/ui/Radio.tsx` | IMPLEMENTED |
| `Switch` | `10:144` | `4:24` | `Checked` Off\|On; `State` Default\|Hover\|Focus\|Disabled | `components/ui/Switch.tsx` | IMPLEMENTED |
| `Chip` | `11:54` | `4:25` | `Selected` No\|Yes; `State` Default\|Hover\|Focus\|Disabled | `components/ui/Chip.tsx` | IMPLEMENTED |
| `Tab` | `11:79` | `4:25` | `Selected` No\|Yes; `State` Default\|Hover\|Focus | `components/ui/Tabs.tsx` | IMPLEMENTED |
| `PhotoCard` | `12:263` | `4:26` | `Aspect` Landscape 3:2\|Square 1:1\|Portrait 4:5; `State` Default\|Sensitive\|Loading | `components/ui/PhotoCard.tsx` (presentational; no route renders it yet) | IMPLEMENTED |
| `Avatar` | `14:56` | `4:27` | `Size` XS\|SM\|MD\|LG; `Type` Image\|Initials\|Fallback | `components/ui/Avatar.tsx` | IMPLEMENTED |
| `TabBar Item` / `TabBar` | `15:31` / `15:32` | `4:28` | `Selected` No\|Yes; `State` Default\|Focus | `components/ui/TabBar.tsx` (presentational; no route renders it yet) | IMPLEMENTED |
| `TopNav` | `15:74` | `4:28` | single | superseded at M1 by `TopNav / M1` below | — |
| `TopNav / M1` | `30:770` | `4:28` | `State` Signed out\|Signed in | `components/shell/TopBar.tsx` (wordmark only) | PARTIAL |
| `AppBar / M1` | `30:814` | `4:28` | `State` Signed out\|Signed in | `components/shell/TopBar.tsx`, `components/shell/SkipLink.tsx` | PARTIAL |
| `Dialog` | `16:43` | `4:29` | `Kind` Standard\|Destructive | `components/ui/Dialog.tsx` | IMPLEMENTED (browser behaviour UNVERIFIED: no production route renders it) |
| `Toast / Inline status` | `17:40` | `4:30` | `Tone` Success\|Error\|Info | `components/ui/Toast.tsx` | IMPLEMENTED |
| `Banner` | `17:68` | `4:30` | `Tone` Info\|Warn\|Danger | `components/ui/Banner.tsx` | IMPLEMENTED |
| `Skeleton` | `17:72` | `4:30` | `Shape` Line\|Block\|Circle | `components/ui/Skeleton.tsx` | IMPLEMENTED |
| `EmptyState` | `17:95` | `4:30` | `Kind` Empty\|No results | `components/ui/EmptyState.tsx` | IMPLEMENTED |
| `ErrorState` | `17:96` | `4:30` | single | `components/ui/ErrorState.tsx` | IMPLEMENTED |

## 3. Brand mark

**Not defined in the accepted design.** README §6 departure 14 removed the
mockup's gradient mark; only the text style `brand/Wordmark (placeholder)`
exists ("not a logo"). Brand assets are a separately reviewed deliverable
(OPEN_QUESTIONS Q-002: meta `brand/` after Prompt 02). The shell keeps the
text wordmark; no mark is invented here.

## 4. Icons — `components/icons/registry.ts` (Lucide `lucide-react` 1.46.0)

Page `Icons` (`4:32`). The Figma glyphs are stand-ins; the shipping SVG is
the pinned package's (§7). `registry.test.ts` checks every export exists and
is canonical.

| Registry name | `lucide-react` export | Figma node |
|---|---|---|
| `upload` | `Upload` | `5:20` |
| `favorite` | `Heart` | `5:12` |
| `rating` | `Star` | `5:15` |
| `comment` | `MessageCircle` | `5:64` |
| `add-to-album` | `FolderPlus` | `5:69` |
| `share` | `Share2` | `5:76` |
| `download` | `Download` | `5:25` |
| `report` | `Flag` | `5:61` |
| `delete` | `Trash` | `5:32` |
| `search` | `Search` | `5:5` |
| `filter` | `SlidersHorizontal` | `5:87` |
| `visibility-public` | `Globe` | `5:41` |
| `visibility-unlisted` | `Link` | `5:45` |
| `visibility-private` | `Lock` | `5:36` |
| `visibility-password` | `KeyRound` | `5:49` |
| `settings` | `Settings` | `5:53` |
| `notifications` | `Bell` | `5:57` |
| `close` | `X` | `5:9` |
| `back` | `ArrowLeft` | `5:91` |
| `previous` | `ChevronLeft` | `5:94` |
| `next` | `ChevronRight` | `5:97` |
| `expand` | `ChevronDown` | `5:100` |
| `zoom-in` | `ZoomIn` | `5:106` |
| `zoom-out` | `ZoomOut` | `5:111` |
| `confirm` | `Check` | `5:114` |
| `loading` | `LoaderCircle` | `5:117` |
| `info` | `Info` | `5:122` |
| `warning` | `TriangleAlert` | `5:127` |
| `success` | `CircleCheck` | `5:131` |
| `error` | `CircleAlert` | `5:136` |
| `photo` | `Image` | `5:141` |
| `albums` | `Images` | `28:585` |
| `storage` | `HardDrive` | `28:595` |
| `sign-out` | `LogOut` | `28:605` |
| `hidden` | `EyeOff` | `5:147` |
| `retry` | `RotateCw` | `5:151` |
| `more` | `Ellipsis` | `5:156` |
| `person` | `User` | `5:160` |
| `home` | `House` | `5:164` |
| `edit` | `Pencil` | `5:168` |
