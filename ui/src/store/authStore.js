import { create } from 'zustand';

// Use environment variable if available, otherwise fallback (for local dev)
const API_BASE = import.meta.env.VITE_API_URL || "https://telegram-archiver-api.iflove29.workers.dev";

export const useAuthStore = create((set, get) => ({
  // State
  isLoggedIn: false,
  isLoading: false,
  error: null,
  sessionString: null,
  phoneCodeHash: null,
  requires2FA: false,
  
  // Actions
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  
  login: (sessionString) => set({ 
    isLoggedIn: true, 
    sessionString,
    error: null,
    requires2FA: false,
    phoneCodeHash: null
  }),
  
  logout: () => set({ 
    isLoggedIn: false, 
    sessionString: null,
    error: null,
    requires2FA: false,
    phoneCodeHash: null
  }),
  
  setPhoneCodeHash: (phoneCodeHash) => set({ phoneCodeHash }),
  setRequires2FA: (requires2FA) => set({ requires2FA }),
  
  // API Actions
  startAuth: async (phoneNumber) => {
    set({ isLoading: true, error: null });
    
    try {
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber })
      });
      
      const data = await response.json();
      
      if (data.success) {
        set({ 
          phoneCodeHash: data.phoneCodeHash,
          requires2FA: false,
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
        error: 'Network error. Please try again.',
        isLoading: false 
      });
      return { success: false, error: 'Network error' };
    }
  },
  
  verifyCode: async (phoneNumber, phoneCode) => {
    const { phoneCodeHash } = get();
    
    set({ isLoading: true, error: null });
    
    try {
      const response = await fetch(`${API_BASE}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber, phoneCode, phoneCodeHash })
      });
      
      const data = await response.json();
      
      if (data.success) {
        set({ 
          isLoggedIn: true,
          sessionString: data.sessionString,
          phoneCodeHash: null,
          isLoading: false 
        });
        return { success: true };
      } else if (data.requires2FA) {
        set({ 
          requires2FA: true,
          isLoading: false 
        });
        return { success: false, requires2FA: true, error: data.error };
      } else {
        set({ 
          error: data.error,
          isLoading: false 
        });
        return { success: false, error: data.error };
      }
    } catch (error) {
      set({ 
        error: 'Network error. Please try again.',
        isLoading: false 
      });
      return { success: false, error: 'Network error' };
    }
  },
  
  verify2FA: async (password) => {
    set({ isLoading: true, error: null });
    
    try {
      const response = await fetch(`${API_BASE}/auth/verify2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      
      const data = await response.json();
      
      if (data.success) {
        set({ 
          isLoggedIn: true,
          sessionString: data.sessionString,
          requires2FA: false,
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
        error: 'Network error. Please try again.',
        isLoading: false 
      });
      return { success: false, error: 'Network error' };
    }
  }
}));
