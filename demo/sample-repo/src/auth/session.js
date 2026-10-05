export function isValidSession(session) {
  return Boolean(session && session.userId && session.expiresAt > Date.now());
}

// Message shown to users when their session ends.
export const SESSION_EXPIRED_MESSAGE = "Your sesion has expired. Please sign in again.";
