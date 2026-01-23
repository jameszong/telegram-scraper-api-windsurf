import { create } from 'zustand';
import { SCANNER_URL, PROCESSOR_URL, VIEWER_URL, authenticatedFetch } from '../utils/api';
import { useChannelStore } from './channelStore';

export const useMessageStore = create((set, get) => ({
  // State
  messages: [],
  isLoading: false,
  isSyncing: false,
  syncProgress: 0,  // Add sync progress tracking
  syncStatus: '',   // Add sync status message
  error: null,
  hasMore: true,
  offset: 0,
  total: null, // Add total count for pagination
  
  // Actions
  setLoading: (loading) => set({ isLoading: loading }),
  setSyncing: (syncing) => set({ isSyncing: syncing }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  
  setMessages: (messages) => set({ messages }),
  addMessages: (newMessages) => set(state => ({
    messages: [...state.messages, ...newMessages]
  })),
  
  // API Actions
  fetchMessages: async (limit = 50, reset = false, channelId = null) => {
    const { messages, offset } = get();
    
    // Use passed channelId or get from store if not provided
    const selectedChannel = channelId || useChannelStore.getState().selectedChannel;
    
    if (!selectedChannel || !selectedChannel.id) {
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
      // CRITICAL: Use VIEWER_URL for read-only message fetching
      const response = await authenticatedFetch(`${VIEWER_URL}/messages?channelId=${selectedChannel.id}&limit=${limit}&offset=${currentOffset}`);
      const data = await response.json();
      
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
    set({ syncStatus: 'Phase B: Processing media queue...' });
    
    let processedCount = 0;
    const maxMediaBatches = 50; // Process up to 50 media files
    
    for (let i = 0; i < maxMediaBatches; i++) {
      set({ 
        syncProgress: i + 1, 
        syncStatus: `Phase B: Processing media ${i + 1}/${maxMediaBatches}...` 
      });
      
      console.log(`Debug: Phase B - Processing media batch ${i + 1}/${maxMediaBatches}`);
      
      const response = await authenticatedFetch(`${PROCESSOR_URL}/process-media`, {
        method: 'POST'
      });
      
      const data = await response.json();
      
      if (data.success) {
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
          
          // Update local messages state to include new media_url for instant display
          const { messages } = get();
          const updatedMessages = messages.map(msg => {
            if (msg.telegram_message_id === data.messageId && data.result?.mediaKey) {
              const r2PublicUrl = "https://pub-5e1e5a4b6b8b4a8b8b8b8b8b8b8b8b8b.r2.dev"; // This should come from env
              return {
                ...msg,
                media_url: `${r2PublicUrl}/${data.result.mediaKey}`
              };
            }
            return msg;
          });
          
          set({ messages: updatedMessages });
          
          set({ 
            syncStatus: `Phase B: Processing media queue: ${data.remaining} remaining... (Processed: ${processedCount})` 
          });
        }
        
        // Dynamic cooldown for media processing (CPU intensive)
        const cooldown = 2000; // 2 second delay for CPU recovery
        console.log(`Debug: Phase B - Waiting ${cooldown}ms for CPU recovery...`);
        await new Promise(resolve => setTimeout(resolve, cooldown));
      } else {
        console.error(`Debug: Phase B - Media processing failed: ${data.error}`);
        // Don't throw error for media processing failures, just continue
        console.log(`Debug: Phase B - Continuing despite media processing error...`);
      }
    }
    
    console.log(`Debug: Phase B completed - Total media processed: ${processedCount}`);
  },
}));
