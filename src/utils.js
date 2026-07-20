import { CONFIG } from './config.js';
import { Logger } from './logger.js';

// --- 加密安全的随机数 ---

export function secureRandomInt(min, max) {
    const range = max - min;
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    return min + (bytes[0] % range);
}

export function secureRandomId(length = 12) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// --- KV 安全读取 ---

export async function safeGetJSON(env, key, defaultValue = null) {
    try {
        const data = await env.TOPIC_MAP.get(key, { type: "json" });
        if (data === null || data === undefined) {
            return defaultValue;
        }
        if (typeof data !== 'object') {
            Logger.warn('kv_invalid_type', { key, type: typeof data });
            return defaultValue;
        }
        return data;
    } catch (e) {
        Logger.error('kv_parse_failed', e, { key });
        return defaultValue;
    }
}

// --- Telegram 错误描述解析 ---

export function normalizeTgDescription(description) {
    return (description || "").toString().toLowerCase();
}

export function isTopicMissingOrDeleted(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("thread not found") ||
           desc.includes("topic not found") ||
           desc.includes("message thread not found") ||
           desc.includes("topic deleted") ||
           desc.includes("thread deleted") ||
           desc.includes("forum topic not found") ||
           desc.includes("topic closed permanently");
}

export function isTestMessageInvalid(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("message text is empty") ||
           desc.includes("bad request: message text is empty");
}

// --- 辅助函数 ---

export function withMessageThreadId(body, threadId) {
    if (threadId === undefined || threadId === null) return body;
    return { ...body, message_thread_id: threadId };
}

// Fisher-Yates 洗牌算法
export function shuffleArray(arr) {
    const array = [...arr];
    for (let i = array.length - 1; i > 0; i--) {
        const j = secureRandomInt(0, i + 1);
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 话题标题构建（清理特殊字符）
export function buildTopicTitle(from) {
    const firstName = (from.first_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
    const lastName = (from.last_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);

    // 清理 username
    let username = "";
    if (from.username) {
        username = from.username
            .replace(/[^\w]/g, '')
            .substring(0, 20);
    }

    // 移除控制字符和换行符
    const cleanName = (firstName + " " + lastName)
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const name = cleanName || "User";
    const usernameStr = username ? ` @${username}` : "";

    const title = (name + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);
    return title;
}

// 媒体消息提取
export function extractMedia(msg) {
    // 图片
    if (msg.photo && msg.photo.length > 0) {
        const highestResolution = msg.photo[msg.photo.length - 1];
        return {
            type: "photo",
            id: highestResolution.file_id,
            cap: msg.caption || ""
        };
    }

    // 视频
    if (msg.video) {
        return { type: "video", id: msg.video.file_id, cap: msg.caption || "" };
    }

    // 文档
    if (msg.document) {
        return { type: "document", id: msg.document.file_id, cap: msg.caption || "" };
    }

    // 音频
    if (msg.audio) {
        return { type: "audio", id: msg.audio.file_id, cap: msg.caption || "" };
    }

    // 动图
    if (msg.animation) {
        return { type: "animation", id: msg.animation.file_id, cap: msg.caption || "" };
    }

    // 语音和视频消息不支持 media group
    return null;
}
