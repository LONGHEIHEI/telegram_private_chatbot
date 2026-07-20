/**
 * 重试管理器
 * 统一管理重试逻辑，包括指数退避和错误分类
 */

import { Logger } from './logger.js';

/**
 * 错误类型分类
 */
export const ErrorType = {
    NETWORK: 'network',
    TIMEOUT: 'timeout',
    RATE_LIMIT: 'rate_limit',
    SERVER_ERROR: 'server_error',
    CLIENT_ERROR: 'client_error',
    UNKNOWN: 'unknown'
};

/**
 * 判断错误类型
 */
export function classifyError(error, apiResponse = null) {
    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
        return ErrorType.TIMEOUT;
    }
    
    if (error.message?.includes('fetch') || error.message?.includes('network')) {
        return ErrorType.NETWORK;
    }
    
    if (apiResponse?.description) {
        const desc = apiResponse.description.toLowerCase();
        
        if (desc.includes('too many requests') || desc.includes('retry after')) {
            return ErrorType.RATE_LIMIT;
        }
        
        if (desc.includes('internal server error') || desc.includes('bad gateway')) {
            return ErrorType.SERVER_ERROR;
        }
        
        if (desc.includes('bad request') || desc.includes('not found') || desc.includes('unauthorized')) {
            return ErrorType.CLIENT_ERROR;
        }
    }
    
    return ErrorType.UNKNOWN;
}

/**
 * 判断错误是否可重试
 */
export function isRetryableError(error, apiResponse = null) {
    const errorType = classifyError(error, apiResponse);
    
    // 网络错误、超时、服务器错误和速率限制都可以重试
    return [
        ErrorType.NETWORK,
        ErrorType.TIMEOUT,
        ErrorType.SERVER_ERROR,
        ErrorType.RATE_LIMIT
    ].includes(errorType);
}

/**
 * 计算重试延迟（指数退避）
 */
export function calculateRetryDelay(attempt, baseDelay = 1000, maxDelay = 32000) {
    // 指数退避：2^attempt * baseDelay，但不超过 maxDelay
    const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    // 添加随机抖动，避免同时重试
    const jitter = Math.random() * 0.3 * delay;
    return Math.floor(delay + jitter);
}

/**
 * 执行带重试的异步操作
 */
export async function retryOperation(
    operation,
    { 
        maxAttempts = 3, 
        baseDelay = 1000, 
        maxDelay = 32000,
        onError = null,
        context = {}
    } = {}
) {
    let lastError = null;
    let lastResponse = null;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const result = await operation(attempt);
            
            // 如果成功，返回结果
            if (attempt > 0) {
                Logger.info('retry_success', { 
                    attempt, 
                    maxAttempts, 
                    context 
                });
            }
            
            return result;
        } catch (error) {
            lastError = error;
            lastResponse = error.response || null;
            
            // 判断是否可重试
            if (!isRetryableError(error, lastResponse)) {
                Logger.warn('retry_non_retryable_error', {
                    errorType: classifyError(error, lastResponse),
                    context,
                    errorMessage: error.message
                });
                throw error;
            }
            
            // 如果是最后一次尝试，不再重试
            if (attempt === maxAttempts - 1) {
                Logger.error('retry_max_attempts_reached', error, {
                    attempt: attempt + 1,
                    maxAttempts,
                    context
                });
                throw error;
            }
            
            // 计算延迟
            const delay = calculateRetryDelay(attempt, baseDelay, maxDelay);
            
            Logger.warn('retry_attempt', {
                attempt: attempt + 1,
                maxAttempts,
                delay,
                errorType: classifyError(error, lastResponse),
                errorMessage: error.message,
                context
            });
            
            // 调用错误回调
            if (onError) {
                try {
                    await onError(error, attempt, delay);
                } catch (callbackError) {
                    Logger.error('retry_callback_failed', callbackError, { context });
                }
            }
            
            // 等待后重试
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    // 理论上不会到这里，但为了类型安全
    throw lastError;
}

/**
 * 创建超时的 Promise
 */
export function createTimeoutPromise(timeoutMs, errorMessage = 'Operation timeout') {
    return new Promise((_, reject) => {
        setTimeout(() => {
            const error = new Error(errorMessage);
            error.name = 'TimeoutError';
            reject(error);
        }, timeoutMs);
    });
}

/**
 * 带超时的操作
 */
export async function withTimeout(operation, timeoutMs, errorMessage = 'Operation timeout') {
    return Promise.race([
        operation(),
        createTimeoutPromise(timeoutMs, errorMessage)
    ]);
}

/**
 * 电路断路器状态
 */
export const CircuitState = {
    CLOSED: 'closed',   // 正常状态
    OPEN: 'open',       // 断路状态
    HALF_OPEN: 'half_open' // 半开状态
};

/**
 * 电路断路器
 * 防止对失败的服务进行重复调用
 */
export class CircuitBreaker {
    constructor({
        failureThreshold = 5,
        recoveryTimeout = 60000,
        halfOpenMaxCalls = 3,
        name = 'circuit-breaker'
    } = {}) {
        this.name = name;
        this.failureThreshold = failureThreshold;
        this.recoveryTimeout = recoveryTimeout;
        this.halfOpenMaxCalls = halfOpenMaxCalls;
        
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = 0;
        this.halfOpenCallCount = 0;
    }

    /**
     * 执行带断路保护的调用
     */
    async execute(operation) {
        // 如果断路器打开，拒绝调用
        if (this.state === CircuitState.OPEN) {
            if (this.shouldAttemptReset()) {
                this.state = CircuitState.HALF_OPEN;
                this.halfOpenCallCount = 0;
                Logger.info('circuit_breaker_half_open', { name: this.name });
            } else {
                const error = new Error(`Circuit breaker "${this.name}" is OPEN`);
                error.name = 'CircuitBreakerOpenError';
                throw error;
            }
        }

        try {
            const result = await operation();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    /**
     * 成功时调用
     */
    onSuccess() {
        if (this.state === CircuitState.HALF_OPEN) {
            this.halfOpenCallCount++;
            
            // 如果半开状态下多次成功，关闭断路器
            if (this.halfOpenCallCount >= this.halfOpenMaxCalls) {
                this.state = CircuitState.CLOSED;
                this.failureCount = 0;
                this.successCount = 0;
                Logger.info('circuit_breaker_closed', { 
                    name: this.name,
                    halfOpenCallCount: this.halfOpenCallCount 
                });
            }
        } else {
            this.failureCount = 0;
            this.successCount++;
        }
    }

    /**
     * 失败时调用
     */
    onFailure() {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        this.successCount = 0;

        if (this.failureCount >= this.failureThreshold) {
            this.state = CircuitState.OPEN;
            Logger.warn('circuit_breaker_opened', {
                name: this.name,
                failureCount: this.failureCount,
                threshold: this.failureThreshold
            });
        }
    }

    /**
     * 判断是否应该尝试重置
     */
    shouldAttemptReset() {
        return Date.now() - this.lastFailureTime >= this.recoveryTimeout;
    }

    /**
     * 获取断路器状态
     */
    getState() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            successCount: this.successCount,
            lastFailureTime: this.lastFailureTime,
            isHealthy: this.state !== CircuitState.OPEN
        };
    }

    /**
     * 手动重置断路器
     */
    reset() {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        this.halfOpenCallCount = 0;
        this.lastFailureTime = 0;
        Logger.info('circuit_breaker_reset', { name: this.name });
    }
}

/**
 * 全局断路器实例
 */
const apiCircuitBreaker = new CircuitBreaker({
    failureThreshold: 5,
    recoveryTimeout: 60000,
    halfOpenMaxCalls: 3,
    name: 'telegram-api'
});

/**
 * 执行带断路保护的 API 调用
 */
export async function withCircuitBreaker(operation) {
    return apiCircuitBreaker.execute(operation);
}

/**
 * 获取断路器状态
 */
export function getCircuitBreakerStatus() {
    return apiCircuitBreaker.getState();
}

/**
 * 手动重置断路器
 */
export function resetCircuitBreaker() {
    apiCircuitBreaker.reset();
}
