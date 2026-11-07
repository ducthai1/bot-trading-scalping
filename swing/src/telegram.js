// Telegram sender: never throws (a Telegram outage must not stop the bot), retries 3 times,
// splits messages over Telegram's 4096-char limit.
import { sleep } from './util.js';

export function createTelegram({ token, chatId, dry = false, log = console }) {
  const enabled = !!(token && chatId) && !dry;
  async function sendOne(text) {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) return true;
        const body = await res.text();
        if (res.status === 429) await sleep((JSON.parse(body).parameters?.retry_after ?? 5) * 1000);
        else if (res.status < 500) throw new Error(`Telegram ${res.status}: ${body.slice(0, 200)}`);
      } catch (e) {
        if (i === 2) {
          log.error(`❌ Gửi Telegram thất bại: ${e.message}`);
          return false;
        }
      }
      await sleep(1000 * 2 ** i);
    }
    return false;
  }
  return {
    enabled,
    async send(text) {
      if (!enabled) {
        log.log(`[telegram${dry ? ' dry' : ' tắt'}]\n${text.replace(/<[^>]+>/g, '')}`);
        return false;
      }
      const parts = [];
      let cur = '';
      for (const line of text.split('\n')) {
        if ((cur + line).length > 3900) {
          parts.push(cur);
          cur = '';
        }
        cur += (cur ? '\n' : '') + line;
      }
      if (cur) parts.push(cur);
      let ok = true;
      for (const p of parts) ok = (await sendOne(p)) && ok;
      return ok;
    },
  };
}
