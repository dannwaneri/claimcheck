export function slugify(s) {
  return s.toLowerCase().replace(/\s+/g, "-");
}

export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
