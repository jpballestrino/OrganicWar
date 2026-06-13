// Escapes a string for safe interpolation into HTML via innerHTML.
// Use this for any user-controlled value (display names, guild names/tags,
// nicknames, descriptions) that gets placed inside a template literal.
export function escapeHtml(value) {
  if (value === null || value === undefined) { return ''; }
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
