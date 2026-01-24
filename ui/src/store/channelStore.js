import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { API_BASE, authenticatedFetch } from '../utils/api';

export const useChannelStore = create(
  persist(
    (set, get) => ({
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
      setSelectedChannel: (channel) => {
        set({ selectedChannel: channel });
        // Also save to localStorage for persistence
        if (channel?.id) {
          localStorage.setItem('lastChannelId', channel.id);
        }
      },
  
  // API Actions
  fetchChannels: async () => {
    set({ isLoading: true, error: null });
    
    try {
      const response = await authenticatedFetch(`${API_BASE}/channels`);
      
      // Check if response exists and is ok
      if (!response || !response.ok) {
        throw new Error(`HTTP ${response?.status || 'unknown'}: ${response?.statusText || 'Network error'}`);
      }
      
      const data = await response.json();
      
      // Check if data exists and has success property
      if (!data || typeof data.success === 'undefined') {
        throw new Error('Invalid response format from server');
      }
      
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
      const response = await authenticatedFetch(`${API_BASE}/channels/select`, {
        method: 'POST',
        body: JSON.stringify({ channelId })
      });
      
      // Check if response exists and is ok
      if (!response || !response.ok) {
        throw new Error(`HTTP ${response?.status || 'unknown'}: ${response?.statusText || 'Network error'}`);
      }
      
      const data = await response.json();
      
      // Check if data exists and has success property
      if (!data || typeof data.success === 'undefined') {
        throw new Error('Invalid response format from server');
      }
      
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
  },
  
  // Initialize selected channel from localStorage
  initializeFromStorage: () => {
    console.log('[ChannelStore] initializeFromStorage called');
    const lastChannelId = localStorage.getItem('lastChannelId');
    console.log('[ChannelStore] Last channelId from localStorage:', lastChannelId);
    
    if (lastChannelId) {
      const { channels } = get();
      console.log('[ChannelStore] Available channels:', channels.length);
      const selected = channels.find(ch => ch.id === lastChannelId);
      console.log('[ChannelStore] Found selected channel:', selected ? selected.title : 'Not found');
      
      if (selected) {
        set({ selectedChannel: selected });
        console.log('[ChannelStore] Selected channel restored:', selected.id, selected.title);
      } else {
        console.warn('[ChannelStore] Last channel not found in available channels');
      }
    } else {
      console.log('[ChannelStore] No last channel ID in localStorage');
    }
  }
}),
  {
    name: 'channel-storage',
    partialize: (state) => ({ selectedChannel: state.selectedChannel })
  })
);
