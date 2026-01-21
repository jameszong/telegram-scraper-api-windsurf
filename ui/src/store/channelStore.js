import { create } from 'zustand';

// Use environment variable if available, otherwise fallback (for local dev)
const API_BASE = import.meta.env.VITE_API_URL || "https://telegram-archiver-api.iflove29.workers.dev";

export const useChannelStore = create((set, get) => ({
  // State
  channels: [],
  selectedChannel: null,
  isLoading: false,
  error: null,
  
  // Actions
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  
  setChannels: (channels) => set({ channels }),
  setSelectedChannel: (channel) => set({ selectedChannel: channel }),
  
  // API Actions
  fetchChannels: async () => {
    set({ isLoading: true, error: null });
    
    try {
      const response = await fetch(`${API_BASE}/channels`);
      const data = await response.json();
      
      if (data.success) {
        set({ 
          channels: data.channels,
          isLoading: false 
        });
        return { success: true, channels: data.channels };
      } else {
        set({ 
          error: data.error,
          isLoading: false 
        });
        return { success: false, error: data.error };
      }
    } catch (error) {
      set({ 
        error: 'Failed to fetch channels',
        isLoading: false 
      });
      return { success: false, error: 'Network error' };
    }
  },
  
  selectChannel: async (channelId) => {
    set({ isLoading: true, error: null });
    
    try {
      const response = await fetch(`${API_BASE}/channels/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId })
      });
      
      const data = await response.json();
      
      if (data.success) {
        const { channels } = get();
        const selected = channels.find(ch => ch.id === channelId);
        set({ 
          selectedChannel: selected,
          isLoading: false 
        });
        return { success: true };
      } else {
        set({ 
          error: data.error,
          isLoading: false 
        });
        return { success: false, error: data.error };
      }
    } catch (error) {
      set({ 
        error: 'Failed to select channel',
        isLoading: false 
      });
      return { success: false, error: 'Network error' };
    }
  }
}));
