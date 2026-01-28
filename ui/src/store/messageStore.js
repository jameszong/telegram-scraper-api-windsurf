import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SCANNER_URL, PROCESSOR_URL, VIEWER_URL, authenticatedFetch, internalFetch } from '../utils/api';
import { useChannelStore } from './channelStore';

export const useMessageStore = create(
  persist(
    (set, get) => ({
  // State
  messages: [],
  isLoading: false,
  isSyncing: false,
  isProcessing: false, // Add processing state for polling
  lastActivityTimestamp: null, // Track last successful activity for watchdog
  syncProgress: 0,  // Add sync progress tracking
  syncStatus: '',   // Add sync status message
  error: null,
  hasMore: true,
  offset: 0,
  total: null, // Add total count for pagination
  
  // Actions
  setLoading: (loading) => {
    console.log('[MessageStore] setLoading called with:', loading);
    set({ isLoading: loading });
  },
  setSyncing: (syncing) => set({ isSyncing: syncing }),
  setProcessing: (processing) => set({ isProcessing: processing }),
  updateActivity: () => set({ lastActivityTimestamp: Date.now() }), // Update activity timestamp
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  
  setMessages: (messages) => set({ messages }),
  addMessages: (newMessages) => set(state => ({
    messages: [...state.messages, ...newMessages]
  })),
  
  // API Actions
  fetchMessages: async (limit = 50, reset = false, channelId = null) => {
    const { messages, offset } = get();
    
    // CRITICAL FIX: Prioritize channelId argument over store state
    const targetId = channelId || useChannelStore.getState().selectedChannel?.id;
    
    console.log('[MessageStore] fetchMessages called with:', {
      limit,
      reset,
      channelIdArg: channelId,
      storeChannelId: useChannelStore.getState().selectedChannel?.id,
      targetId
    });
    
    if (!targetId) {
      console.error('[MessageStore] No channel ID available for fetchMessages');
      set({ error: 'No channel selected', isLoading: false });
      return { success: false, error: 'No channel selected' };
    }
    
    if (reset) {
      set({ isLoading: true, error: null, messages: [], offset: 0, hasMore: true });
    } else {
      set({ isLoading: true, error: null });
    }
    
    try {
      const currentOffset = reset ? 0 : offset;
      // CRITICAL: Use targetId from argument prioritization
      const response = await authenticatedFetch(`${VIEWER_URL}/messages?channelId=${targetId}&limit=${limit}&offset=${currentOffset}`);
      
      console.log('[MessageStore] API call made to:', `${VIEWER_URL}/messages?channelId=${targetId}&limit=${limit}&offset=${currentOffset}`);
      
      // Check if response exists and is ok
      if (!response || !response.ok) {
        throw new Error(`HTTP ${response?.status || 'unknown'}: ${response?.statusText || 'Network error'}`);
      }
      
      // Handle non-JSON responses (like HTML error pages)
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error(`Invalid response type: ${contentType || 'unknown'}`);
      }
      
      const data = await response.json();
      
      // Check if data exists and has success property
      if (!data || typeof data.success === 'undefined') {
        throw new Error('Invalid response format from server');
      }
      
      if (data.success) {
        const fetchedMessages = data.messages || [];
        // CRITICAL FIX: Use pagination data from backend
        const pagination = data.pagination || {};
        const hasMore = pagination.hasMore !== undefined ? pagination.hasMore : fetchedMessages.length === limit;
        
        if (reset) {
          set({ 
            messages: fetchedMessages,
            offset: fetchedMessages.length,
            hasMore,
            isLoading: false,
            total: pagination.total || null
          });
        } else {
          set({ 
            messages: [...messages, ...fetchedMessages],
            offset: offset + fetchedMessages.length,
            hasMore,
            isLoading: false,
            total: pagination.total || null
          });
        }
        
        console.log(`Frontend: Fetched ${fetchedMessages.length} messages, total: ${pagination.total}, hasMore: ${hasMore}`);
        
        // Enhanced debugging: Log raw API data structure
        if (fetchedMessages.length > 0) {
          console.log("[MessageStore] Debug Message Structure:", fetchedMessages[0]);
          console.log("[MessageStore] Raw API data received - First 2 messages:", 
            fetchedMessages.slice(0, 2).map(msg => ({
              telegram_message_id: msg.telegram_message_id,
              media_status: msg.media_status,
              media_type: msg.media_type,
              media_key: msg.media_key,
              media_url: msg.media_url,
              grouped_id: msg.grouped_id,
              allKeys: Object.keys(msg)
            }))
          );
        }
        
        return { success: true, messages: fetchedMessages, hasMore };
      } else {
        set({ 
          error: data.error,
          isLoading: false 
        });
        return { success: false, error: data.error };
      }
    } catch (error) {
      set({ 
        error: 'Failed to fetch messages',
        isLoading: false 
      });
      return { success: false, error: 'Network error' };
    }
  },
  
  syncMessages: async () => {
    set({ isSyncing: true, syncProgress: 0, syncStatus: 'Starting sync...', error: null });
    
    try {
      // Phase A: Fast Text Sync
      const { phaseATextSync, phaseBMediaProcessing } = get();
      await phaseATextSync();
      
      // Phase B: Media Processing Queue
      await phaseBMediaProcessing();
      
      // Final refresh to show completed media
      const { fetchMessages } = get();
      await fetchMessages(50, true);
      
      set({ 
        isSyncing: false, 
        syncStatus: 'Sync complete! All messages and media processed.' 
      });
      
    } catch (error) {
      console.error('Sync error:', error);
      set({ 
        isSyncing: false, 
        error: 'Sync failed: ' + error.message,
        syncStatus: 'Sync failed'
      });
    }
  },

  phaseATextSync: async () => {
    const maxBatches = 15; // Increased for faster text sync
    let emptyBatches = 0;
    let totalSynced = 0;
    
    set({ syncStatus: 'Phase A: Syncing messages...' });
    
    for (let i = 0; i < maxBatches; i++) {
      set({ 
        syncProgress: i + 1, 
        syncStatus: `Phase A: Syncing batch ${i + 1}/${maxBatches}...` 
      });
      
      console.log(`Debug: Phase A - Syncing batch ${i + 1}/${maxBatches}`);
      
      const response = await authenticatedFetch(`${SCANNER_URL}/sync`, {
        method: 'POST'
      });
      
      const data = await response.json();
      
      if (data.success) {
        totalSynced += data.synced || 0;
        console.log(`Debug: Phase A - Batch ${i + 1} result: synced=${data.synced}, hasNewMessages=${data.hasNewMessages}, messages_returned=${data.messages?.length || 0}`);
        
        // IMMEDIATE UPDATE: Add new messages to state for instant visibility
        if (data.messages && data.messages.length > 0) {
          const { messages } = get();
          const newMessages = [...data.messages, ...messages];
          set({ messages: newMessages });
          console.log(`Frontend: Phase A - Immediately updated UI with ${data.messages.length} new messages. Total: ${newMessages.length}`);
        }
        
        // More resilient stopping logic
        if (data.synced === 0) {
          emptyBatches++;
          console.log(`Debug: Phase A - Empty batch ${i + 1}, consecutive empty: ${emptyBatches}`);
          
          // Only stop after 2 consecutive empty batches
          if (emptyBatches >= 2) {
            console.log(`Debug: Phase A - Stopping after ${emptyBatches} consecutive empty batches`);
            break;
          }
        } else {
          emptyBatches = 0; // Reset counter on successful batch
        }
        
        // Also stop if API explicitly says no more messages
        if (!data.hasNewMessages) {
          console.log(`Debug: Phase A - No more messages to sync (API confirmation), stopping at batch ${i + 1}`);
          break;
        }
        
        // Short cooldown for lightweight text sync
        if (i < maxBatches - 1) {
          const cooldown = data.suggestedCooldown || 500; // Short delay for text-only
          console.log(`Debug: Phase A - Waiting ${cooldown}ms before next batch...`);
          await new Promise(resolve => setTimeout(resolve, cooldown));
        }
      } else {
        console.error(`Debug: Phase A - Batch ${i + 1} failed: ${data.error}`);
        throw new Error(`Phase A sync failed: ${data.error}`);
      }
    }
    
    // No need to refresh messages - we already updated them immediately during Phase A
    console.log(`Debug: Phase A completed - Total synced: ${totalSynced}`);
  },

  phaseBMediaProcessing: async () => {
    // Prevent double polling: check if already processing
    const { isProcessing } = get();
    if (isProcessing) {
      console.log('[Phase B] Already processing, skipping duplicate call');
      return;
    }
    
    try {
      set({ 
        syncStatus: 'Phase B: Processing media queue...',
        isProcessing: true,
        lastActivityTimestamp: Date.now(), // Initialize activity timestamp
        error: null
      });
      
      let processedCount = 0;
      let batchCount = 0;
      let batchSize = 1; // 动态批处理大小，从 1 开始
      const maxBatches = 200; // Safety limit
      let retryCount = 0;
      const maxRetries = 3; // 最多重试3次
      let rateLimitRetries = 0; // 429 错误的连续重试次数
      let baseWaitTime = 5; // 基础等待时间（秒）
      let recoveryMode = false; // 恢复模式标志
      
      // Get current channel ID for targeted processing
      const currentChannelId = useChannelStore.getState().selectedChannel?.id;
      console.log(`[Phase B] Starting targeted processing for channel: ${currentChannelId}`);
      
      // Client-side orchestration loop
      const processAllMedia = async () => {
        while (batchCount < maxBatches) {
          batchCount++;
          
          set({
            syncProgress: batchCount,
            syncStatus: `Phase B: Processing media... (Batch ${batchCount})`
          });
          
          try {
            // Include chatId parameter for targeted processing
            const url = currentChannelId 
              ? `${PROCESSOR_URL}/process-media?batch=true&size=${batchSize}&chatId=${currentChannelId}`
              : `${PROCESSOR_URL}/process-media?batch=true&size=${batchSize}`;
            
            console.log(`[Phase B] Requesting batch ${batchCount} with retry ${retryCount}/${maxRetries}`);
            const response = await internalFetch(url, {
              method: 'POST'
            });
            
            // 成功请求后重置所有重试计数
            retryCount = 0;
            rateLimitRetries = 0;
            
            // 如果在恢复模式且已成功 5 次，退出恢复模式
            if (recoveryMode && batchCount % 5 === 0) {
              console.log('[Phase B] Recovery successful, returning to normal mode');
              recoveryMode = false;
              batchSize = 1; // 保持安全的批处理大小
            }
            
            if (response.status === 401) {
              console.error('[Phase B] HTTP 401 Unauthorized - Credential error detected');
              set({
                syncStatus: 'Error: Telegram credentials missing. Please refresh the page to let Scanner sync credentials first.',
                error: 'Telegram credentials missing. Please refresh the page to let Scanner sync credentials first.'
              });
              return false; // Stop processing
            }
            
            // Handle 429 FloodWaitError with Smart Retry and Exponential Backoff
            if (response.status === 429) {
              rateLimitRetries++;
              
              let waitTime = baseWaitTime;
              const data = await response.json().catch(() => ({}));
              
              // 优先使用服务器返回的等待时间
              if (data.floodWait) {
                waitTime = data.floodWait;
              } else {
                // 指数退避：5s -> 10s -> 20s -> 40s
                waitTime = baseWaitTime * Math.pow(2, rateLimitRetries - 1);
                // 最大等待时间 60 秒
                waitTime = Math.min(waitTime, 60);
              }
              
              console.log(`[Phase B] Rate limit hit (attempt ${rateLimitRetries}). Waiting ${waitTime}s before retry...`);
              
              // 进入恢复模式：强制 batchSize = 1
              if (!recoveryMode) {
                console.log('[Phase B] Entering recovery mode: forcing batchSize = 1');
                recoveryMode = true;
                batchSize = 1;
              }
              
              set({
                syncStatus: `Rate limit hit. Waiting ${waitTime}s before retry... (Attempt ${rateLimitRetries})`
              });
              
              // 等待指定时间后自动重试
              await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
              
              // 重试当前批次
              batchCount--;
              continue;
            }
            
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            console.log(`[Phase B] Batch ${batchCount} response:`, data);
            
            // Update activity timestamp on successful response
            set({ lastActivityTimestamp: Date.now() });
            
            if (!data || !data.success) {
              throw new Error(data?.error || 'Batch processing failed');
            }
            
            if (!data.batchMode) {
              console.log('[Phase B] Fallback to single item mode');
              // Fallback to single item processing
              const singleUrl = currentChannelId 
                ? `${PROCESSOR_URL}/process-media?chatId=${currentChannelId}`
                : `${PROCESSOR_URL}/process-media`;
              const singleResponse = await internalFetch(singleUrl, { method: 'POST' });
              if (!singleResponse.ok) {
                throw new Error(`Single item fallback failed: ${singleResponse.status}`);
              }
              const singleData = await singleResponse.json();
              if (singleData?.success && singleData.processedId) {
                processedCount++;
                // Update UI for single processed item
                const { messages } = get();
                const updatedMessages = messages.map(msg => {
                  if (msg.telegram_message_id === singleData.messageId && singleData.mediaKey) {
                    return {
                      ...msg,
                      media_status: 'completed',
                      media_key: singleData.mediaKey,
                      r2_key: singleData.mediaKey,
                      media_url: `${VIEWER_URL}/media/${singleData.mediaKey}`
                    };
                  }
                  return msg;
                });
                set({ messages: updatedMessages });
              }
              return singleData?.remaining === 0; // Continue if more items
            }
            
            // OPTIMISTIC UI UPDATE: Use processedItems for instant updates
            const { messages } = get();
            const updatedMessages = messages.map(msg => {
              // First check processedItems array (optimistic update)
              const processedItem = data.processedItems?.find(
                item => String(item.telegram_message_id) === String(msg.telegram_message_id)
              );
              
              if (processedItem && processedItem.media_key) {
                console.log(`[Phase B] OPTIMISTIC UPDATE: Message ${msg.telegram_message_id} completed with key ${processedItem.media_key}`);
                return {
                  ...msg,
                  media_status: 'completed',
                  media_key: processedItem.media_key,
                  r2_key: processedItem.media_key,
                  media_url: `${VIEWER_URL}/media/${processedItem.media_key}`
                };
              }
              
              // Fallback to results array for skipped items
              const result = data.results?.find(r => r.messageId === msg.telegram_message_id);
              if (result && result.skipped) {
                return {
                  ...msg,
                  media_status: result.skipReason?.includes('Non-photo') ? 'skipped_type' :
                               result.skipReason?.includes('large') ? 'skipped_large' : 'skipped'
                };
              }
              
              return msg;
            });
            set({ messages: updatedMessages });
            
            processedCount += Number(data.processedCount || 0);
            const remaining = Number(data.remaining || 0);
            const hasMore = remaining > 0;
            
            if (!hasMore) {
              set({
                syncStatus: `Phase B: All media processing complete! Processed ${processedCount} items.`
              });
              return false; // Stop processing
            }
            
            set({
              syncStatus: `Phase B: Processing media... ${remaining} remaining (Processed: ${processedCount})`
            });
            
            // Wait before next batch to avoid overwhelming the worker
            await new Promise(resolve => setTimeout(resolve, 800));
            
          } catch (error) {
            console.error(`[Phase B] Batch ${batchCount} error:`, error);
            
            // 特殊处理超时错误
            if (error.name === 'AbortError' || error.message.includes('timeout')) {
              console.log(`[Phase B] Timeout detected, reducing batch size and retrying`);
              
              // 动态减小批处理大小（如果当前大小 > 1）
              if (batchSize > 1) {
                console.log(`[Phase B] Reducing batch size from ${batchSize} to 1`);
                // 这里我们不能直接修改 const，但可以记录并建议用户刷新
                set({
                  syncStatus: `Timeout detected. Please refresh the page to continue with smaller batch size.`,
                  error: 'Request timeout. Please refresh the page.'
                });
                return false;
              }
              
              retryCount++;
              if (retryCount <= maxRetries) {
                const waitTime = 2000; // 超时后等待 2 秒
                console.log(`[Phase B] Timeout retry (${retryCount}/${maxRetries}) after ${waitTime}ms`);
                
                set({
                  syncStatus: `Timeout, retrying (${retryCount}/${maxRetries})...`
                });
                
                await new Promise(resolve => setTimeout(resolve, waitTime));
                batchCount--; // 重置批次计数器以重试当前批次
                continue;
              }
            }
            
            // 处理 HTTP 429 错误（从 error.message 中捕获）
            if (error.message.includes('HTTP 429')) {
              rateLimitRetries++;
              
              // 指数退避：5s -> 10s -> 20s -> 40s
              const waitTime = baseWaitTime * Math.pow(2, rateLimitRetries - 1);
              const cappedWaitTime = Math.min(waitTime, 60);
              
              console.log(`[Phase B] Rate limit error (attempt ${rateLimitRetries}). Waiting ${cappedWaitTime}s before retry...`);
              
              // 进入恢复模式：强制 batchSize = 1
              if (!recoveryMode) {
                console.log('[Phase B] Entering recovery mode: forcing batchSize = 1');
                recoveryMode = true;
                batchSize = 1;
              }
              
              set({
                syncStatus: `Rate limit hit. Waiting ${cappedWaitTime}s before retry... (Attempt ${rateLimitRetries})`
              });
              
              // 等待后自动重试
              await new Promise(resolve => setTimeout(resolve, cappedWaitTime * 1000));
              batchCount--;
              continue;
            }
            
            // 如果是网络错误，尝试重试
            if (error.message.includes('Failed to fetch') || 
                error.message.includes('ERR_CONNECTION') || 
                error.message.includes('NetworkError')) {
              
              retryCount++;
              
              if (retryCount <= maxRetries) {
                const waitTime = retryCount * 1000; // 逐次增加等待时间
                console.log(`[Phase B] Network error, retrying (${retryCount}/${maxRetries}) after ${waitTime}ms`);
                
                set({
                  syncStatus: `Network error, retrying (${retryCount}/${maxRetries})...`
                });
                
                // 等待后重试当前批次
                await new Promise(resolve => setTimeout(resolve, waitTime));
                batchCount--; // 重置批次计数器以重试当前批次
                continue;
              }
            }
            
            // 重试次数超过或非网络错误，停止处理
            set({
              syncStatus: `Error: Batch ${batchCount} failed - ${error.message}`,
              error: error.message
            });
            return false; // 停止处理
          }
        }
        
        // Safety limit reached
        set({
          syncStatus: `Phase B: Stopped after ${maxBatches} batches (processed: ${processedCount}). Please try again.`
        });
        return false;
      };
      
      // Start the client-side orchestration
      await processAllMedia();
      
    } catch (error) {
      console.error('[Phase B] Unexpected error:', error);
      set({ 
        syncStatus: 'Error: Media processing failed - ' + error.message,
        error: 'Media processing failed: ' + error.message
      });
    } finally {
      set({ 
        isProcessing: false,
        isLoading: false
      });
    }
  },

  // Auto-polling for real-time updates
  startPolling: () => {
    const { isProcessing } = get();
    if (isProcessing) return; // Already polling

    // CRITICAL: Don't set isProcessing here, it conflicts with media processing state
    // Use a separate polling state if needed
    
    const pollInterval = setInterval(async () => {
      const { isProcessing: currentlyProcessing } = get();
      if (!currentlyProcessing) {
        clearInterval(pollInterval);
        return;
      }

      try {
        const { fetchMessages } = get();
        await fetchMessages(50, true);
      } catch (error) {
        console.error('[MessageStore] Polling error:', error);
      }
    }, 5000); // Poll every 5 seconds

    return () => clearInterval(pollInterval);
  },
}),
{
  name: 'message-storage',
  partialize: (state) => ({ 
    messages: state.messages,
    hasMore: state.hasMore,
    offset: state.offset,
    total: state.total
  }),
  onRehydrateStorage: () => (state) => {
    console.log('[MessageStore] onRehydrateStorage called');
    if (state) {
      console.log('[MessageStore] Persisted state restored:', {
        messagesCount: state.messages?.length || 0,
        hasMore: state.hasMore,
        offset: state.offset,
        total: state.total
      });
    } else {
      console.log('[MessageStore] No persisted state found, starting fresh');
    }
  }
}));
