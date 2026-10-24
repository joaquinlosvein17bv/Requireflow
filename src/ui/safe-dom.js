// Small DOM helpers that keep untrusted values out of HTML parsing.

/**
 * Escapes text for the rare case where a string must be placed inside an HTML
 * template. Prefer `createEl`/`textContent`, which never parse markup.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NAMED_COLOR_PATTERN = /^[a-zA-Z]{3,20}$/;

/**
 * Restricts a colour to a CSS colour literal. Dropping anything else prevents
 * a stored value from breaking out of a `style` attribute.
 */
export function safeColor(value, fallback = "#6366f1") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (COLOR_PATTERN.test(trimmed)) return trimmed;
  if (NAMED_COLOR_PATTERN.test(trimmed)) return trimmed;
  return fallback;
}

/**
 * Builds an element from plain data. Text children always go through
 * `createTextNode`, so task titles, section names and similar values are never
 * parsed as markup.
 */
export function createEl(tag, props = {}, children = []) {
  const element = document.createElement(tag);

  if (props.class) element.className = props.class;
  if (props.text !== undefined && props.text !== null) {
    element.textContent = String(props.text);
  }
  if (props.dataset) {
    for (const [key, value] of Object.entries(props.dataset)) {
      if (value !== undefined && value !== null) element.dataset[key] = String(value);
    }
  }
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      if (value !== undefined && value !== null) element.setAttribute(key, String(value));
    }
  }
  if (props.style) {
    for (const [key, value] of Object.entries(props.style)) {
      if (value !== undefined && value !== null) element.style.setProperty(key, String(value));
    }
  }
  if (props.on) {
    for (const [event, handler] of Object.entries(props.on)) {
      element.addEventListener(event, handler);
    }
  }

  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return element;
}
