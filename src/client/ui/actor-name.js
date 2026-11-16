/** Presentation only: identity comes from actor metadata, never its nickname. */
export function actorLabel(actor) {
  const icon = { bot: '🤖', human: '👤' }[actor.controlType];
  return icon ? `${icon} ${actor.name}` : String(actor.name);
}

/** Escapes the complete label for the HUD's HTML text positions. */
export function actorLabelHtml(actor) {
  return actorLabel(actor).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
