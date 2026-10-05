export function slugify(s) {
  return s.toLowerCase().replace(/\s+/g, "-");
}

export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Messages shown to users.
export const MESSAGES = {
  welcome: "Wellcome back!",
  saved: "Your changes were saved sucessfully.",
  goodbye: "See you soon.",
};
