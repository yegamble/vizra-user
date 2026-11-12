/**
 * The typed semantic icon registry (VZ-DESIGN-001, docs/DESIGN_BRIEF.md "Icons").
 *
 * One family — Lucide, ISC — behind names that say what a control MEANS
 * (`favorite`, `delete`), not what it looks like (`Heart`, `Trash`). A call
 * site writes `<Icon name="favorite" />`; a name that is not a key of `ICONS`
 * is a type error (see `icon.typecheck.tsx`), and there is no path from a
 * runtime string to an icon.
 *
 * Every import below is a NAMED, STATIC import of an export that was checked
 * against the installed `lucide-react` 1.46.0 — its type declarations and its
 * runtime module — and `registry.test.ts` re-checks all of them on every run,
 * including that each is the package's CANONICAL name and not a compatibility
 * alias. That check already changed one entry: the design proposed `Trash2`
 * for delete, and in 1.46.0 `Trash2` is only an alias of `Trash`.
 *
 * Adding an icon: add the import and the entry here, add the row to
 * `design/HANDOFF.md` §4 with its Figma node, and the test does the rest. Do not
 * add an icon the accepted design does not name.
 */

import {
  ArrowLeft,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Download,
  Ellipsis,
  EyeOff,
  Flag,
  FolderPlus,
  Globe,
  HardDrive,
  Heart,
  House,
  Image,
  Images,
  Info,
  KeyRound,
  Link,
  LoaderCircle,
  Lock,
  LogOut,
  MessageCircle,
  Pencil,
  RotateCw,
  Search,
  Settings,
  Share2,
  SlidersHorizontal,
  Star,
  Trash,
  TriangleAlert,
  Upload,
  User,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

export const ICONS = {
  upload: Upload,
  // Favorite and rating are deliberately different glyphs AND different
  // semantics: a binary `aria-pressed` toggle versus a 1-5 radiogroup value.
  favorite: Heart,
  rating: Star,
  comment: MessageCircle,
  "add-to-album": FolderPlus,
  share: Share2,
  download: Download,
  report: Flag,
  delete: Trash,
  search: Search,
  filter: SlidersHorizontal,
  "visibility-public": Globe,
  "visibility-unlisted": Link,
  "visibility-private": Lock,
  "visibility-password": KeyRound,
  settings: Settings,
  notifications: Bell,
  close: X,
  back: ArrowLeft,
  previous: ChevronLeft,
  next: ChevronRight,
  expand: ChevronDown,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
  confirm: Check,
  loading: LoaderCircle,
  info: Info,
  warning: TriangleAlert,
  success: CircleCheck,
  error: CircleAlert,
  photo: Image,
  albums: Images,
  storage: HardDrive,
  "sign-out": LogOut,
  hidden: EyeOff,
  retry: RotateCw,
  more: Ellipsis,
  person: User,
  home: House,
  edit: Pencil,
} as const satisfies Record<string, LucideIcon>;

/** The only values an icon name can take. Not `string`, and never widened. */
export type IconName = keyof typeof ICONS;
