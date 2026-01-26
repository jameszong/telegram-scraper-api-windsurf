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
    try {
      set({ 
        syncStatus: 'Phase B: Processing media queue...',
        isProcessing: true
      });
      
      let processedCount = 0;
      const maxMediaBatches = 50; // Process up to 50 media files
      
      // NEW: Check if we should use batch processing
      const useBatchProcessing = true; // Enable batch mode by default
      
      if (useBatchProcessing) {
        console.log(`Debug: Phase B - Using batch processing mode`);
        
        // Single batch request to process all pending items
        set({ 
          syncProgress: 1, 
          syncStatus: `Phase B: Batch processing all pending media...` 
        });

        const batchSize = 8;
        const maxLoops = 500;
        let lastRemaining = null;
        let loops = 0;

        while (loops < maxLoops) {
          loops++;

          set({
            syncProgress: loops,
            syncStatus: `Phase B: Processing media... (Batch ${loops})`
          });

          const response = await internalFetch(`${PROCESSOR_URL}/process-media?batch=true&size=${batchSize}`, {
            method: 'POST'
          });

          if (response.status === 401) {
            console.error('[Phase B] HTTP 401 Unauthorized - Credential error detected');
            set({
              syncStatus: 'Error: Telegram credentials missing. Please refresh the page to let Scanner sync credentials first.',
              error: 'Telegram credentials missing. Please refresh the page to let Scanner sync credentials first.'
            });
            return;
          }

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const data = await response.json();
          console.log(`Debug: Phase B - Batch Processor response:`, data);

          if (!data || !data.success) {
            throw new Error(data?.error || 'Batch processing failed');
          }

          if (!data.batchMode) {
            console.log(`Debug: Phase B - Falling back to single item mode`);
            return await processSingleItems(set, get, internalFetch, PROCESSOR_URL, VIEWER_URL, maxMediaBatches);
          }

          processedCount += Number(data.processedCount || 0);

          const { messages } = get();
          const updatedMessages = messages.map(msg => {
            const result = data.results.find(r => r.messageId === msg.telegram_message_id);
            if (result && result.success && !result.skipped && result.mediaKey) {
              return {
                ...msg,
                media_status: 'completed',
                media_key: result.mediaKey,
                r2_key: result.mediaKey,
                media_url: `${VIEWER_URL}/media/${result.mediaKey}`
              };
            } else if (result && result.skipped) {
              return {
                ...msg,
                media_status: result.skipReason?.includes('Non-photo') ? 'skipped_type' :
                             result.skipReason?.includes('large') ? 'skipped_large' : 'skipped'
              };
            }
            return msg;
          });
          set({ messages: updatedMessages });

          const remaining = Number(data.remaining || 0);

          if (remaining === 0) {
            set({
              syncStatus: `Phase B: All media processing complete! Processed ${processedCount} items.`
            });
            break;
          }

          if (lastRemaining !== null && remaining === lastRemaining) {
            console.log(`Debug: Phase B - Remaining unchanged (${remaining}); stopping to avoid infinite loop`);
            set({
              syncStatus: `Phase B: Stopped - remaining did not change (${remaining}). Please check Processor logs.`
            });
            break;
          }

          lastRemaining = remaining;

          set({
            syncStatus: `Phase B: Processing media... ${remaining} remaining (Processed: ${processedCount})`
          });
        }
      } else {
        // Original single-item processing logic
        return await processSingleItems(set, get, internalFetch, PROCESSOR_URL, VIEWER_URL, maxMediaBatches);
      }
      
      // Helper function for single item processing
      async function processSingleItems(set, get, internalFetch, PROCESSOR_URL, VIEWER_URL, maxMediaBatches) {
        for (let i = 0; i < maxMediaBatches; i++) {
          set({ 
            syncProgress: i + 1, 
            syncStatus: `Phase B: Processing media ${i + 1}/${maxMediaBatches}...` 
          });
          
          console.log(`Debug: Phase B - Processing media batch ${i + 1}/${maxMediaBatches}`);
          
          const response = await internalFetch(`${PROCESSOR_URL}/process-media`, {
            method: 'POST'
          });
          
          // CRITICAL: Check HTTP status for credential errors before parsing JSON
          if (response.status === 401) {
            console.error('[Phase B] HTTP 401 Unauthorized - Credential error detected');
            set({ 
              syncStatus: 'Error: Telegram credentials missing. Please refresh the page to let Scanner sync credentials first.',
              error: 'Telegram credentials missing. Please refresh the page to let Scanner sync credentials first.'
            });
            return; // Stop the loop immediately
          }
          
          const data = await response.json();
          
          console.log(`Debug: Phase B - Processor response:`, data);
          
          // CRITICAL FIX: Use optional chaining for response.data.success
          if (data && data.success) {
            if (data.remaining === 0) {
              console.log(`Debug: Phase B - No more media to process`);
              set({ 
                syncStatus: `Phase B: Media processing complete! Processed ${processedCount} items.` 
              });
              break;
            }
            
            if (data.processedId) {
              processedCount++;
              console.log(`Debug: Phase B - Processed 1 media item. Queue remaining: ${data.remaining}`);
              console.log(`Debug: Phase B - Processor response data:`, {
                messageId: data.messageId,
                mediaKey: data.mediaKey,
                skipped: data.skipped,
                skipReason: data.skipReason
              });
              
              // Update local messages state to include new media_url for instant display
              const { messages } = get();
              const updatedMessages = messages.map(msg => {
                if (msg.telegram_message_id === data.messageId && data.mediaKey) {
                  return {
                    ...msg,
                    media_status: 'completed',
                    media_key: data.mediaKey,
                    r2_key: data.mediaKey,
                    media_url: `${VIEWER_URL}/media/${data.mediaKey}`
                  };
                }
                return msg;
              });
              
              set({ messages: updatedMessages });
            }
          } else {
            console.error('[Phase B] Processor returned failure:', data);
            set({ 
              syncStatus: `Error: Media processing failed - ${data.error || 'Unknown error'}`,
              error: data.error || 'Unknown error'
            });
            break;
          }
        }
      }
      
      console.log(`Debug: Phase B completed - Total media processed: ${processedCount}`);
      
      // CRITICAL: Force refresh messages after processing to update Archive list
      const { selectedChannel } = useChannelStore.getState();
      if (selectedChannel && selectedChannel.id) {
        console.log(`Debug: Phase B - Forcing message refresh for channel ${selectedChannel.id}`);
        const { fetchMessages } = get();
        await fetchMessages(50, true, selectedChannel.id);
      }
      
    } catch (error) {
      console.error('[Phase B] Unexpected error:', error);
      set({ 
        syncStatus: 'Error: Media processing failed - ' + error.message,
        error: 'Media processing failed: ' + error.message
      });
    } finally {
      // CRITICAL: Always reset isProcessing and loading states
      console.log('[Phase B] Finally block - Resetting isProcessing and loading to false');
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
