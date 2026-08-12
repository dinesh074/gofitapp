// Native no-op stub. On web, Metro resolves googleWeb.web.ts instead, which
// implements Google Identity Services. Native uses expo-auth-session, so these
// are never called there — they exist only to satisfy the shared import + types.

export async function initGoogleWeb(
  _clientId: string,
  _onCredential: (idToken: string) => void
): Promise<void> {
  // no-op on native
}

export function renderGoogleButton(_el: unknown, _width?: number): void {
  // no-op on native
}

export function promptGoogleWeb(): void {
  // no-op on native
}

export function currentOrigin(): string {
  return "";
}
