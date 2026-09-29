export interface BackgroundWorkItem {
  id: string;
  taskId?: string;
  source?: string;
  label?: string;
  command?: string;
  status: string;
  exitCode?: number;
  elapsedMs?: number;
  outputPath?: string;
  tail?: string;
  ts?: number;
}

export interface BackgroundWorkInfo {
  kind: string;
  deliveryMode: string;
  items: BackgroundWorkItem[];
  remainingTaskIds?: string[];
}
