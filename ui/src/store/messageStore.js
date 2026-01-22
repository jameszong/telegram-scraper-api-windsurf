import { create } from 'zustand';
import { API_BASE, authenticatedFetch } from '../utils/api';
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
      // CRITICAL: Pass channelId to prevent data leakage
      const response = await authenticatedFetch(`${API_BASE}/messages?channelId=${selectedChannel.id}&limit=${limit}&offset=${currentOffset}`);
      const data = await response.json();
      
      if (data.success) {
        const fetchedMessages = data.messages || [];
        const hasMore = fetchedMessages.length === limit;
        
        if (reset) {
          set({ 
            messages: fetchedMessages,
            offset: fetchedMessages.length,
            hasMore,
            isLoading: false 
          });
        } else {
          set({ 
            messages: [...messages, ...fetchedMessages],
            offset: currentOffset + fetchedMessages.length,
            hasMore,
            isLoading: false 
          });
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
    set({ isSyncing: true, syncProgress: 0, syncStatus: 'Starting sequential sync...', error: null });
    
    try {
      let totalSynced = 0;
      let totalMedia = 0;
      const maxBatches = 10;  // Sync up to 10 messages
      
      for (let i = 0; i < maxBatches; i++) {
        // Update progress
        set({ 
          syncProgress: i + 1, 
          syncStatus: `Syncing batch ${i + 1}/${maxBatches}...` 
        });
        
        console.log(`Debug: Syncing batch ${i + 1}/${maxBatches}`);
        
        const response = await authenticatedFetch(`${API_BASE}/sync`, {
          method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
          totalSynced += data.synced || 0;
          totalMedia += data.media || 0;
          
          console.log(`Debug: Batch ${i + 1} result: synced=${data.synced}, media=${data.media}, hasNewMessages=${data.hasNewMessages}`);
          
          // Stop if no new messages
          if (!data.hasNewMessages) {
            console.log(`Debug: No more messages to sync, stopping at batch ${i + 1}`);
            set({ 
              syncStatus: `Sync complete! Processed ${totalSynced} messages with ${totalMedia} media files.` 
            });
            break;
          }
        } else {
          console.error(`Debug: Batch ${i + 1} failed: ${data.error}`);
          set({ 
            error: data.error,
            syncStatus: `Sync failed at batch ${i + 1}: ${data.error}` 
          });
          break;
        }
        
        // Small delay to prevent overwhelming the worker
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Reset and fetch messages after sync
      const { fetchMessages } = get();
      await fetchMessages(50, true);
      
      set({ 
        isSyncing: false,
        syncStatus: `Sync complete! Processed ${totalSynced} messages with ${totalMedia} media files.`
      });
      
      return { success: true, synced: totalSynced, media: totalMedia };
    } catch (error) {
      console.error('Sequential sync error:', error);
      set({ 
        error: 'Failed to sync messages',
        isSyncing: false,
        syncStatus: 'Sync failed due to network error'
      });
      return { success: false, error: 'Network error' };
    }
  }
}));
