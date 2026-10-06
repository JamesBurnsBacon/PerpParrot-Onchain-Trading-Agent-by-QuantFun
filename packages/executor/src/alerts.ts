// Telegram alerts (README §4.7, §4.8). Without a bot token, alerts go to the log only.
export type Alert = (message: string) => Promise<void>;

export const createAlert = (opts: { botToken?: string; chatId?: string; log: (msg: string) => void }): Alert => {
  if (!opts.botToken || !opts.chatId) {
    return async (message) => opts.log(`[alert] ${message}`);
  }
  const url = `https://api.telegram.org/bot${opts.botToken}/sendMessage`;
  return async (message) => {
    opts.log(`[alert] ${message}`);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: opts.chatId, text: `PerpParrot executor: ${message}` }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (e) {
      opts.log(`[alert] Telegram send failed: ${(e as Error).message}`);
    }
  };
};
