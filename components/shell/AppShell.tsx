import type { ReactNode } from "react";

import { MAIN_CONTENT_ID, SkipLink } from "./SkipLink";
import { TopBar } from "./TopBar";

/**
 * The application shell: skip link, top bar, and the page's one `<main>`.
 *
 * DOM order is the focus order the design specifies — skip link, wordmark,
 * then the page. A page rendered inside the shell supplies content only; it
 * must not render its own `<main>` (one per document).
 */
export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <SkipLink />
      <TopBar />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="px-4 py-6 md:px-8 md:py-10">
        {children}
      </main>
    </>
  );
}
