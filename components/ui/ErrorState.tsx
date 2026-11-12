import { Icon } from "@/components/icons/Icon";

import { Button } from "./Button";

/**
 * Figma `ErrorState` (`17:96`, page `4:30`), single component. Always carries
 * retry (`onRetry` is required); says what did not happen and what was not
 * changed. The caller supplies sanitised copy — never a stack trace, internal
 * id or signed URL.
 */
export interface ErrorStateProps {
  readonly title: string;
  /** What did not happen and what was not changed. */
  readonly body: string;
  readonly onRetry: () => void;
  readonly retryLabel?: string;
}

export function ErrorState({ title, body, onRetry, retryLabel = "Try again" }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="text-danger-ink">
        <Icon name="error" size="lg" />
      </span>
      <h2 className="text-title-3 text-ink">{title}</h2>
      <p className="max-w-prose text-body text-ink-2">{body}</p>
      <Button kind="secondary" label={retryLabel} leadingIcon="retry" onClick={onRetry} />
    </div>
  );
}
