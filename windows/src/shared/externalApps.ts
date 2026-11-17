export interface ExternalAppsSettings {
  nowPlaying: boolean;
  discord: boolean;
  discordId: string;
}

export interface ExternalAppsStatus {
  settings: ExternalAppsSettings;
  obsURL?: string;
  port?: number;
  error?: string;
  discordStatus: 'off' | 'missing-id' | 'waiting' | 'ready' | 'active' | 'rejected';
}
