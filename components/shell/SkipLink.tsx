/** The id of the shell's `<main>`; the skip link's only destination. */
export const MAIN_CONTENT_ID = "content";

/**
 * "Skip to content" — the first Tab stop on every page (control
 * `shell.skip_link`, VZ-A11Y-001). A real link to `main#content`, which is
 * focusable (`tabindex="-1"`) so focus actually moves there.
 *
 * Hidden until focused, then drawn ABOVE the sticky bar (`z-20` over the
 * bar's `z-10`) so the focused link is never obscured (WCAG 2.2 2.4.11).
 */
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="sr-only rounded-sm bg-bg-elevated text-label text-accent-ink shadow-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-20 focus:inline-flex focus:min-h-touch-min focus:items-center focus:px-4"
    >
      Skip to content
    </a>
  );
}
