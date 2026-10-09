export type TaskNotification = {
  key: string;
  category: 'failure' | 'stuck' | 'completed';
  title: string;
  body: string;
  jobId: string;
  jobKind: string;
  batchId?: string;
};
