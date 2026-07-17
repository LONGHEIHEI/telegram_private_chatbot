import { Logger } from './logger.js';
import { tgCall } from './api.js';
import { handlePrivateMessage, handleAdminReply, handleCallbackQuery, updateThreadStatus, flushExpiredMediaGroups } from './core.js';

export default {
  async fetch(request, env, ctx) {
    // 环境自检
    if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");

    // 规范化环境变量，统一为字符串类型
    const normalizedEnv = {
        ...env,
        SUPERGROUP_ID: String(env.SUPERGROUP_ID),
        BOT_TOKEN: String(env.BOT_TOKEN)
    };

    // 验证 SUPERGROUP_ID 格式
    if (!normalizedEnv.SUPERGROUP_ID.startsWith("-100")) {
        return new Response("Error: SUPERGROUP_ID must start with -100");
    }

    if (request.method !== "POST") return new Response("OK");

    // 验证 Content-Type
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        Logger.warn('invalid_content_type', { contentType });
        return new Response("OK");
    }

    let update;
    try {
      update = await request.json();

      // 验证基本结构
      if (!update || typeof update !== 'object') {
          Logger.warn('invalid_json_structure', { update: typeof update });
          return new Response("OK");
      }
    } catch (e) {
      Logger.error('json_parse_failed', e);
      return new Response("OK");
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    ctx.waitUntil(flushExpiredMediaGroups(normalizedEnv, Date.now()));

    if (msg.chat && msg.chat.type === "private") {
      try {
        await handlePrivateMessage(msg, normalizedEnv, ctx);
      } catch (e) {
        const errText = `⚠️ 系统繁忙，请稍后再试。`;
        await tgCall(normalizedEnv, "sendMessage", { chat_id: msg.chat.id, text: errText });
        Logger.error('private_message_failed', e, { userId: msg.chat.id });
      }
      return new Response("OK");
    }

    // 超级群组消息处理
    if (msg.chat && String(msg.chat.id) === normalizedEnv.SUPERGROUP_ID) {
        if (msg.forum_topic_closed && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, true, normalizedEnv);
            return new Response("OK");
        }
        if (msg.forum_topic_reopened && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, false, normalizedEnv);
            return new Response("OK");
        }
        // 支持 General 话题和普通话题
        const text = (msg.text || "").trim();
        const isCommand = !!text && text.startsWith("/");
        if (msg.message_thread_id || isCommand) {
            await handleAdminReply(msg, normalizedEnv, ctx);
            return new Response("OK");
        }
    }

    return new Response("OK");
  },
};
