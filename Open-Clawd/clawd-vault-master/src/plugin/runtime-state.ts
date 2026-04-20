export interface SessionContextCacheEntry {
  recapText?: string;
  initializedAt: string;
  recapInjected: boolean;
}

export class ClawVaultPluginRuntimeState {
  private startupRecoveryNotice: string | null = null;
  private readonly sessionContextByKey = new Map<string, SessionContextCacheEntry>();
  private lastWeeklyReflectionWeekKey: string | null = null;

  setStartupRecoveryNotice(message: string): void {
    const trimmed = message.trim();
    this.startupRecoveryNotice = trimmed || null;
  }

  consumeStartupRecoveryNotice(): string | null {
    const notice = this.startupRecoveryNotice;
    this.startupRecoveryNotice = null;
    return notice;
  }

  setSessionRecap(sessionKey: string, recapText: string): void {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    this.sessionContextByKey.set(normalizedSessionKey, {
      recapText: recapText.trim(),
      initializedAt: new Date().toISOString(),
      recapInjected: false
    });
  }

  getSessionRecap(sessionKey: string | undefined): SessionContextCacheEntry | null {
    if (!sessionKey) return null;
    return this.sessionContextByKey.get(sessionKey) ?? null;
  }

  markSessionRecapInjected(sessionKey: string): void {
    const current = this.sessionContextByKey.get(sessionKey);
    if (!current) return;
    this.sessionContextByKey.set(sessionKey, { ...current, recapInjected: true });
  }

  clearSession(sessionKey: string | undefined): void {
    if (!sessionKey) return;
    this.sessionContextByKey.delete(sessionKey);
  }

  shouldRunWeeklyReflection(weekKey: string): boolean {
    return this.lastWeeklyReflectionWeekKey !== weekKey;
  }

  markWeeklyReflectionRun(weekKey: string): void {
    this.lastWeeklyReflectionWeekKey = weekKey;
  }
}
