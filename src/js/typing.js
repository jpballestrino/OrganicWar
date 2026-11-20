// Is the player typing in a text field right now? Game keys (camera W/A/S/D,
// build hotkeys, Space) are ignored while they are — but only for a field
// that is actually on screen: the menu's nickname box or the guild chat stay
// focused after they are hidden, and used to swallow every game key.
export function isTyping() {
  const el = document.activeElement;
  if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable)) return false;
  if (el.disabled || el.readOnly) return false;
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}
