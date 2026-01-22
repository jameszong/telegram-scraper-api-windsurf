import { create } from 'zustand';
import { API_BASE, authenticatedFetch } from '../utils/api';

export const useAuthStore = create((set, get) => ({
  // State
  isLoggedIn: false,
  isLoading: false,
  error: null,
  sessionString: null,
  phoneCodeHash: null,
  requires2FA: false,
  tempSessionString: null, // Store session from send-code
  phoneNumber: null, // Store phone number for verification
  
  // Actions
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  
  login: (sessionString) => set({ 
    isLoggedIn: true, 
    sessionString,
    error: null,
    requires2FA: false,
    phoneCodeHash: null,
    phoneNumber: null
  }),
  
  logout: () => set({ 
    isLoggedIn: false, 
    sessionString: null,
    error: null,
    requires2FA: false,
    phoneCodeHash: null,
    tempSessionString: null,
    phoneNumber: null
  }),
  
  setPhoneCodeHash: (phoneCodeHash) => set({ phoneCodeHash }),
  setRequires2FA: (requires2FA) => set({ requires2FA }),
  setTempSessionString: (tempSessionString) => set({ tempSessionString }),
  
  // API Actions
  startAuth: async (phoneNumber) => {
    set({ isLoading: true, error: null });
    
    try {
      const response = await authenticatedFetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ phoneNumber })
      });
      
      const data = await response.json();
      
      if (data.success) {
        set({ 
          phoneNumber, // Save phone number for verification
          phoneCodeHash: data.phoneCodeHash,
          tempSessionString: data.sessionString,
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
  
  verifyCode: async (phoneCode) => {
    const { phoneNumber, phoneCodeHash, tempSessionString } = get();
    
    set({ isLoading: true, error: null });
    
    try {
      const response = await authenticatedFetch(`${API_BASE}/auth/verify`, {
        method: 'POST',
        body: JSON.stringify({ 
          phone: phoneNumber,           // Use 'phone' as expected by backend
          code: phoneCode,             // Use 'code' as expected by backend
          phoneCodeHash,
          session: tempSessionString   // Use 'session' as expected by backend
        })
      });
      
      const data = await response.json();
      
      if (data.success) {
        set({ 
          isLoggedIn: true,
          sessionString: data.sessionString,
          phoneCodeHash: null,
          tempSessionString: null,
          phoneNumber: null, // Clear phone number after successful verification
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
      const response = await authenticatedFetch(`${API_BASE}/auth/verify2fa`, {
        method: 'POST',
        body: JSON.stringify({ password })
      });
      
      const data = await response.json();
      
      if (data.success) {
        set({ 
          isLoggedIn: true,
          sessionString: data.sessionString,
          requires2FA: false,
          tempSessionString: null,
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
