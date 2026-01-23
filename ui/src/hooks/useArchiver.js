import { useEffect } from 'react';
import { useMessageStore } from '../store/messageStore';

export const useArchiver = () => {
  const { 
    isProcessing, 
    isSyncing, 
    syncStatus, 
    error,
    startPolling,
    phaseASync,
    phaseBMediaProcessing
  } = useMessageStore();

  // Auto-polling effect
  useEffect(() => {
    let pollCleanup;

    if (isProcessing || isSyncing) {
      console.log('[useArchiver] Starting polling for real-time updates...');
      pollCleanup = startPolling();
    }

    return () => {
      if (pollCleanup) {
        pollCleanup();
      }
    };
  }, [isProcessing, isSyncing, startPolling]);

  // Combined sync function
  const startSync = async () => {
    try {
      // Phase A: Sync messages
      await phaseASync();
      
      // Phase B: Process media
      await phaseBMediaProcessing();
    } catch (error) {
      console.error('[useArchiver] Sync failed:', error);
    }
  };

  return {
    // State
    isProcessing,
    isSyncing,
    syncStatus,
    error,
    
    // Actions
    startSync,
    phaseASync,
    phaseBMediaProcessing
  };
};
