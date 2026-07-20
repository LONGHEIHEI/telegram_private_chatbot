/**
 * 缓存管理器
 * 统一管理内存缓存，防止内存泄漏
 */

import { CONFIG } from './config.js';
import { Logger } from './logger.js';

// 缓存条目结构
class CacheEntry {
    constructor(value, ttl) {
        this.value = value;
        this.createdAt = Date.now();
        this.ttl = ttl; // 毫秒
    }

    isExpired() {
        return Date.now() - this.createdAt > this.ttl;
    }
}

// 缓存管理器类
export class CacheManager {
    constructor(defaultTTL) {
        this.cache = new Map();
        this.defaultTTL = defaultTTL || CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000;
        this.lastCleanupTime = Date.now();
        this.cleanupInterval = 60000; // 1分钟清理一次
        this.maxCacheSize = 10000; // 最大缓存条目数
    }

    /**
     * 设置缓存
     */
    set(key, value, ttl = this.defaultTTL) {
        // 检查缓存大小，防止无限增长
        if (this.cache.size >= this.maxCacheSize) {
            this.cleanup();
            
            // 如果清理后仍然超过限制，删除最旧的条目
            if (this.cache.size >= this.maxCacheSize) {
                const oldestKey = this.findOldestKey();
                if (oldestKey) {
                    this.cache.delete(oldestKey);
                    Logger.warn('cache_evicted_oldest', { key: oldestKey, cacheSize: this.cache.size });
                }
            }
        }

        this.cache.set(key, new CacheEntry(value, ttl));
    }

    /**
     * 获取缓存
     */
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            return null;
        }

        if (entry.isExpired()) {
            this.cache.delete(key);
            return null;
        }

        return entry.value;
    }

    /**
     * 删除缓存
     */
    delete(key) {
        return this.cache.delete(key);
    }

    /**
     * 清理过期缓存
     */
    cleanup() {
        const beforeSize = this.cache.size;
        const now = Date.now();

        for (const [key, entry] of this.cache.entries()) {
            if (entry.isExpired()) {
                this.cache.delete(key);
            }
        }

        this.lastCleanupTime = now;
        
        if (beforeSize !== this.cache.size) {
            Logger.info('cache_cleanup', { 
                beforeSize, 
                afterSize: this.cache.size,
                cleaned: beforeSize - this.cache.size 
            });
        }
    }

    /**
     * 定期清理（在合适的时间调用）
     */
    scheduledCleanup() {
        const now = Date.now();
        if (now - this.lastCleanupTime > this.cleanupInterval) {
            this.cleanup();
        }
    }

    /**
     * 查找最旧的缓存键
     */
    findOldestKey() {
        let oldestKey = null;
        let oldestTime = Infinity;

        for (const [key, entry] of this.cache.entries()) {
            if (entry.createdAt < oldestTime) {
                oldestTime = entry.createdAt;
                oldestKey = key;
            }
        }

        return oldestKey;
    }

    /**
     * 获取缓存统计信息
     */
    getStats() {
        let expired = 0;
        const now = Date.now();

        for (const entry of this.cache.values()) {
            if (entry.isExpired()) {
                expired++;
            }
        }

        return {
            size: this.cache.size,
            expired,
            maxSize: this.maxCacheSize,
            utilization: this.cache.size / this.maxCacheSize
        };
    }

    /**
     * 清空所有缓存
     */
    clear() {
        const size = this.cache.size;
        this.cache.clear();
        Logger.info('cache_cleared', { size });
    }
}

// 全局缓存实例
const adminCacheManager = new CacheManager(CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000);
const threadHealthCacheManager = new CacheManager(CONFIG.THREAD_HEALTH_TTL_MS);

/**
 * 管理员权限缓存包装器
 */
export class AdminCacheWrapper {
    static get(key) {
        return adminCacheManager.get(key);
    }

    static set(key, value, ttl) {
        adminCacheManager.set(key, value, ttl);
    }

    static delete(key) {
        adminCacheManager.delete(key);
    }

    static cleanup() {
        adminCacheManager.scheduledCleanup();
    }

    static getStats() {
        return adminCacheManager.getStats();
    }
}

/**
 * 话题健康检查缓存包装器
 */
export class ThreadHealthCacheWrapper {
    static get(key) {
        return threadHealthCacheManager.get(key);
    }

    static set(key, value, ttl) {
        threadHealthCacheManager.set(key, value, ttl);
    }

    static delete(key) {
        threadHealthCacheManager.delete(key);
    }

    static cleanup() {
        threadHealthCacheManager.scheduledCleanup();
    }

    static getStats() {
        return threadHealthCacheManager.getStats();
    }
}

/**
 * 定期清理所有缓存
 */
export function cleanupAllCaches() {
    adminCacheManager.scheduledCleanup();
    threadHealthCacheManager.scheduledCleanup();
}

/**
 * 获取所有缓存统计
 */
export function getAllCacheStats() {
    return {
        admin: AdminCacheWrapper.getStats(),
        threadHealth: ThreadHealthCacheWrapper.getStats(),
        timestamp: Date.now()
    };
}
