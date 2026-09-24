// The plugin's mark (a pen nib), drawn inline so it follows the text color
// wherever the plugin renders it. icon.svg carries the same shape for bb's
// own surfaces: the sidebar row, menus and panel tabs.
export function ClaudeDesignMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-icon-root=""
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="M8.5 3.5h7L18.5 11 12 21 5.5 11z" />
      <path d="M12 21v-7.25" />
      <circle cx="12" cy="12" r="1.75" />
    </svg>
  );
}
