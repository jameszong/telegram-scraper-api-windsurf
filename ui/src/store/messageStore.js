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
        lastActivityTimestamp: Date.now(),
        error: null
      });
      
      // STRICT SERIAL MODE: One-by-one processing
      let processedCount = 0;
      let batchCount = 0;
      const BATCH_SIZE = 1; // FORCED: Strict serial processing
      const maxBatches = 1000; // Increased for overnight runs
      let fatalErrorCount = 0; // Track fatal errors (500s, network)
      const MAX_FATAL_ERRORS = 5; // Abort after 5 consecutive fatal errors
      let currentProcessingId = null; // Track current message ID for UI feedback
      
      // Get current channel ID for targeted processing
      const currentChannelId = useChannelStore.getState().selectedChannel?.id;
      console.log(`[Phase B SERIAL] Starting strict one-by-one processing for channel: ${currentChannelId}`);
      
      // Strict Serial Loop: Download One -> Update UI -> Start Next
      const processAllMedia = async () => {
        while (batchCount < maxBatches) {
          batchCount++;
          
          set({
            syncProgress: batchCount,
            syncStatus: `Phase B: Processing item ${batchCount}...`
          });
          
          try {
            // Build URL with BATCH_SIZE = 1 (strict serial)
            const url = currentChannelId 
              ? `${PROCESSOR_URL}/process-media?batch=true&size=${BATCH_SIZE}&chatId=${currentChannelId}`
              : `${PROCESSOR_URL}/process-media?batch=true&size=${BATCH_SIZE}`;
            
            console.log(`[Phase B SERIAL] Processing item ${batchCount} (one-by-one mode)`);
            const response = await internalFetch(url, {
              method: 'POST'
            });
            
            // === HANDLE 401 UNAUTHORIZED ===
            if (response.status === 401) {
              console.error('[Phase B SERIAL] FATAL: HTTP 401 Unauthorized');
              set({
                syncStatus: 'Error: Telegram credentials missing. Please refresh the page.',
                error: 'Telegram credentials missing',
                isProcessing: false
              });
              return false; // ABORT
            }
            
            // === HANDLE 429 RATE LIMIT (NOT A FAILURE) ===
            if (response.status === 429) {
              console.warn(`[Phase B SERIAL] Rate limit hit. Pausing...`);
              
              // Parse Retry-After header (priority) or response body
              let waitTime = 10; // Default 10s
              const retryAfterHeader = response.headers.get('Retry-After');
              
              if (retryAfterHeader) {
                waitTime = parseInt(retryAfterHeader, 10);
                console.log(`[Phase B SERIAL] Using Retry-After header: ${waitTime}s`);
              } else {
                const data = await response.json().catch(() => ({}));
                if (data.floodWait) {
                  waitTime = data.floodWait;
                  console.log(`[Phase B SERIAL] Using floodWait from body: ${waitTime}s`);
                }
              }
              
              // Add 1s buffer for safety
              waitTime += 1;
              
              console.log(`[Phase B SERIAL] Cooling down for ${waitTime}s...`);
              set({
                syncStatus: `⏸️ Rate Limited. Paused for ${waitTime}s...`,
                lastActivityTimestamp: Date.now() // Update activity to prevent watchdog kill
              });
              
              // Wait and retry the SAME batch
              await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
              batchCount--; // Retry current batch
              continue; // NOT a failure, just a pause
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
            
            // === SUCCESS: Immediate UI Update ===
            fatalErrorCount = 0; // Reset fatal error counter on success
            
            // STRICT SERIAL: Immediate UI update after each item
            const { messages } = get();
            const updatedMessages = messages.map(msg => {
              // First check processedItems array (optimistic update)
              const processedItem = data.processedItems?.find(
                item => String(item.telegram_message_id) === String(msg.telegram_message_id)
              );
              
              if (processedItem && processedItem.media_key) {
                currentProcessingId = processedItem.telegram_message_id; // Track for UI feedback
                console.log(`[Phase B SERIAL] ✅ Message ${msg.telegram_message_id} completed with key ${processedItem.media_key}`);
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
                console.log(`[Phase B SERIAL] ⏭️ Message ${msg.telegram_message_id} skipped: ${result.skipReason}`);
                return {
                  ...msg,
                  media_status: result.skipReason?.includes('Non-photo') ? 'skipped_type' :
                               result.skipReason?.includes('large') ? 'skipped_large' : 'skipped'
                };
              }
              
              return msg;
            });
            
            // IMMEDIATE STATE UPDATE: Trigger UI refresh
            set({ 
              messages: updatedMessages,
              lastActivityTimestamp: Date.now() // Pet the watchdog on every success
            });
            
            processedCount += Number(data.processedCount || 0);
            const remaining = Number(data.remaining || 0);
            const hasMore = remaining > 0;
            
            if (!hasMore) {
              set({
                syncStatus: `✅ Phase B: All media processing complete! Processed ${processedCount} items.`,
                isProcessing: false
              });
              return false; // Stop processing
            }
            
            // Visual feedback with current processing ID
            const statusMsg = currentProcessingId 
              ? `Phase B: Processing ID ${currentProcessingId}... (${remaining} remaining, ${processedCount} done)`
              : `Phase B: Processing... ${remaining} remaining (${processedCount} done)`;
            
            set({
              syncStatus: statusMsg
            });
            
            // Yield to UI thread: Allow render before next item
            await new Promise(resolve => setTimeout(resolve, 500));
            
          } catch (error) {
            console.error(`[Phase B SERIAL] FATAL ERROR in item ${batchCount}:`, error);
            
            // === FATAL ERROR HANDLING ===
            // Only abort on: 500s, Network Errors after MAX_FATAL_ERRORS consecutive failures
            fatalErrorCount++;
            
            // Check if this is a recoverable error
            const isNetworkError = error.message.includes('Failed to fetch') || 
                                   error.message.includes('ERR_CONNECTION') || 
                                   error.message.includes('NetworkError') ||
                                   error.name === 'AbortError' ||
                                   error.message.includes('timeout');
            
            const isServerError = error.message.includes('HTTP 5');
            
            if (isNetworkError || isServerError) {
              console.warn(`[Phase B SERIAL] Recoverable error (${fatalErrorCount}/${MAX_FATAL_ERRORS}): ${error.message}`);
              
              if (fatalErrorCount >= MAX_FATAL_ERRORS) {
                console.error(`[Phase B SERIAL] ABORT: ${MAX_FATAL_ERRORS} consecutive fatal errors`);
                set({
                  syncStatus: `❌ Aborted after ${MAX_FATAL_ERRORS} consecutive errors: ${error.message}`,
                  error: `Fatal error: ${error.message}`,
                  isProcessing: false
                });
                return false; // ABORT
              }
              
              // Retry with exponential backoff
              const waitTime = Math.min(fatalErrorCount * 2, 10); // 2s, 4s, 6s, 8s, 10s
              console.log(`[Phase B SERIAL] Retrying after ${waitTime}s (attempt ${fatalErrorCount}/${MAX_FATAL_ERRORS})`);
              
              set({
                syncStatus: `⚠️ Error detected. Retrying in ${waitTime}s... (${fatalErrorCount}/${MAX_FATAL_ERRORS})`,
                lastActivityTimestamp: Date.now()
              });
              
              await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
              batchCount--; // Retry current item
              continue;
            }
            
            // Unknown error - treat as fatal
            console.error(`[Phase B SERIAL] Unknown error type: ${error.message}`);
            set({
              syncStatus: `❌ Fatal error: ${error.message}`,
              error: error.message,
              isProcessing: false
            });
            return false; // ABORT
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
