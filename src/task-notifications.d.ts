import type { Project } from './types';
import type { TaskNotification } from './task-notification-types';

declare module './task-notifications.mjs' {
  export const STALLED_AFTER_MS: number;
  export function collectTaskNotifications(previous: Project | null, next: Project, options?: { now?: number; notified?: Set<string>; activityAt?: Map<string, number> }): TaskNotification[];
}
