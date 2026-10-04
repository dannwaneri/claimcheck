export function isValidSession(session) {
  return Boolean(session && session.userId && session.expiresAt > Date.now());
}
