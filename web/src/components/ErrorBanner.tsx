export function ErrorBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="conn-banner" role="status">
      <span>Can&apos;t reach the server — retrying automatically.</span>
      <button type="button" onClick={onRetry}>
        Retry now
      </button>
    </div>
  );
}
