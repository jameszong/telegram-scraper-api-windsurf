import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useAccessKeyStore = create(
  persist(
    (set, get) => ({
      // State
      accessKey: null,
      isUnlocked: false,
      error: null,
      
      // Actions
      setAccessKey: (accessKey) => set({ 
        accessKey,
        isUnlocked: true,
        error: null
      }),
      
      setError: (error) => set({ error }),
      clearError: () => set({ error: null }),
      
      lock: () => set({ 
        accessKey: null,
        isUnlocked: false,
        error: null
      }),
      
      // Validation
      validateKey: (key) => {
        if (!key || key.length !== 32) {
          set({ error: 'Access key must be exactly 32 characters' });
          return false;
        }
        return true;
      }
    }),
    {
      name: 'access-key-storage',
      partialize: (state) => ({ 
        accessKey: state.accessKey,
        isUnlocked: state.isUnlocked 
      })
    }
  )
);
