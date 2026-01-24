import { useEffect, useMemo } from 'react';
import { useMessageStore } from '../store/messageStore';
import { useChannelStore } from '../store/channelStore';

// Group messages by grouped_id for album display
const groupMessages = (messages) => {
  if (!messages || messages.length === 0) return [];
  
  console.log(`[useArchiver] Processing ${messages.length} messages for grouping`);
  
  const groups = {};
  const result = [];
  let groupCount = 0;
  let individualCount = 0;
  
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
        groupCount++;
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
      individualCount++;
    }
  }
  
  console.log(`[useArchiver] Grouping complete: ${groupCount} groups, ${individualCount} individual messages`);
  
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
    phaseBMediaProcessing,
    fetchMessages
  } = useMessageStore();
  const { selectedChannel } = useChannelStore();

  // Memoized grouped messages
  const groupedMessages = useMemo(() => {
    return groupMessages(messages);
  }, [messages]);

  // Load history when channel changes
  useEffect(() => {
    if (selectedChannel && selectedChannel.id) {
      console.log(`[useArchiver] Loading history for channel ${selectedChannel.id} (${selectedChannel.title})`);
      
      // Set loading state to prevent "No messages" flash
      const { setLoading } = useMessageStore.getState();
      setLoading(true);
      
      fetchMessages(50, true, selectedChannel.id)
        .then(result => {
          console.log(`[useArchiver] History load result:`, {
            success: result?.success,
            messageCount: result?.messages?.length || 0,
            hasMore: result?.hasMore,
            error: result?.error
          });
        })
        .catch(error => {
          console.error('[useArchiver] Failed to load history:', error);
        })
        .finally(() => {
          setLoading(false);
        });
    } else {
      console.log('[useArchiver] No selected channel, skipping history load');
    }
  }, [selectedChannel?.id, fetchMessages]);

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
