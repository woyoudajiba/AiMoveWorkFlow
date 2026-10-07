interface DesktopUpdateInfo {
  available: boolean;
  currentVersion: string;
  version: string;
  displayVersion?: string;
  url?: string;
  sha256?: string;
  releaseNotes?: string;
}

interface DesktopUpdateResult {
  started: boolean;
  version: string;
  displayVersion?: string;
}

interface DesktopProjectFolder {
  path: string;
  directories: Record<'Actor_image' | 'Story_image' | 'Movie' | 'Analysis', string>;
  lastSyncAt?: string | null;
  remoteVideoCleanupAt?: string | null;
}

interface DesktopProjectSyncResult {
  folder: DesktopProjectFolder;
  files: Array<{ relativePath: string; kind: 'image' | 'video' | 'metadata'; bytes: number; sha256: string }>;
  totalBytes: number;
  syncedAt: string;
}

interface Window {
  aiframeDesktop?: {
    version: string;
    displayVersion: string;
    checkForUpdate: () => Promise<DesktopUpdateInfo>;
    installUpdate: () => Promise<DesktopUpdateResult>;
    getProjectFolder: (accountKey: string, projectId: string) => Promise<DesktopProjectFolder | null>;
    chooseProjectFolder: (accountKey: string, projectId: string, projectTitle: string) => Promise<DesktopProjectFolder | null>;
    syncProjectAssets: (payload: { accountKey: string; projectId: string; sessionId: string; snapshot: unknown; assets: Array<{ url: string; relativePath: string; kind: 'image' | 'video' | 'metadata' }> }) => Promise<DesktopProjectSyncResult>;
    markProjectCleaned: (payload: { accountKey: string; projectId: string; videoCount: number; snapshot?: unknown }) => Promise<{ folder: DesktopProjectFolder; status: { cleanedAt: string; videoCount: number } }>;
  };
}
