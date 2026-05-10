declare module "update-notifier" {
  export interface UpdateNotifierOptions {
    pkg: { name: string; version: string };
    updateCheckInterval?: number;
  }

  export interface UpdateNotifierResult {
    update?: {
      current: string;
      latest: string;
    };
  }

  export default function updateNotifier(options: UpdateNotifierOptions): UpdateNotifierResult;
}
