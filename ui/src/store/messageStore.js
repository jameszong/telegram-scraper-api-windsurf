import { create } from 'zustand';
import { API_BASE, authenticatedFetch } from '../utils/api';

export const useMessageStore = create((set, get) => ({
  // State
  messages: [],
  isLoading: false,
  isSyncing: false,
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
  fetchMessages: async (limit = 50, reset = false) => {
    const { offset, messages } = get();
    
    if (reset) {
      set({ isLoading: true, error: null, messages: [], offset: 0, hasMore: true });
    } else {
      set({ isLoading: true, error: null });
    }
    
    try {
      const currentOffset = reset ? 0 : offset;
      const response = await authenticatedFetch(`${API_BASE}/messages?limit=${limit}&offset=${currentOffset}`);
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
    set({ isSyncing: true, error: null });
    
    try {
      const response = await authenticatedFetch(`${API_BASE}/sync`, {
        method: 'POST'
      });
      
      const data = await response.json();
      
      if (data.success) {
        // Reset and fetch messages after sync
        const { fetchMessages } = get();
        await fetchMessages(50, true);
        
        set({ isSyncing: false });
        return { success: true, synced: data.synced, media: data.media };
      } else {
        set({ 
          error: data.error,
          isSyncing: false 
        });
        return { success: false, error: data.error };
      }
    } catch (error) {
      set({ 
        error: 'Failed to sync messages',
        isSyncing: false 
      });
      return { success: false, error: 'Network error' };
    }
  }
}));
