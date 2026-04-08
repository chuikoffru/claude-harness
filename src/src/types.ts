export interface SessionResult {
  session_id: string;
  text: string;
  duration_ms: number;
  total_cost_usd: number;
  stop_reason: string;
}

export interface QueueItem {
  channel: ChannelState;
  prompt: string;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
}

export interface ChannelState {
  name: string;
  topicId: number;
  workDir: string;
  instructions: string;
  model: string;
  sessionId?: string;
  busy: boolean;
}
