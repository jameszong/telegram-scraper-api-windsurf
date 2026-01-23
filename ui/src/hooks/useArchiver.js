import { useEffect, useMemo } from 'react';
import { useMessageStore } from '../store/messageStore';

// Group messages by grouped_id for album display
const groupMessages = (messages) => {
  if (!messages || messages.length === 0) return [];
  
  const groups = {};
  const result = [];
  
  for (const message of messages) {
    const groupId = message.grouped_id;
    
    if (groupId) {
      // This message belongs to a group
      if (!groups[groupId]) {
        // Create group entry with the first message
        groups[groupId] = {
          ...message,
          media_group: [message],
          isGroup: true,
          groupSize: 1
        };
        result.push(groups[groupId]);
      } else {
        // Add to existing group
        groups[groupId].media_group.push(message);
        groups[groupId].groupSize = groups[groupId].media_group.length;
      }
    } else {
      // Individual message, add directly
      result.push({
        ...message,
        isGroup: false,
        media_group: []
      });
    }
  }
  
  return result;
};

export const useArchiver = () => {
  const { 
    messages,
    isProcessing, 
    isSyncing, 
    syncStatus, 
    error,
    startPolling,
    phaseASync,
    phaseBMediaProcessing
  } = useMessageStore();

  // Memoized grouped messages
  const groupedMessages = useMemo(() => {
    return groupMessages(messages);
  }, [messages]);

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
    messages: groupedMessages, // Return grouped messages instead of raw messages
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
