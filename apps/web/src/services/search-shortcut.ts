export function focusSearchFromShortcut(
  event: KeyboardEvent,
  input: HTMLInputElement | null,
): boolean {
  if (
    !(event.ctrlKey || event.metaKey) ||
    event.altKey ||
    event.key.toLowerCase() !== "k"
  )
    return false;
  event.preventDefault();
  input?.focus();
  input?.select();
  return true;
}
