import { useEffect, useMemo, useCallback, useRef } from 'react';
import { useMessageStore } from '../store/messageStore';
import { useChannelStore } from '../store/channelStore';
import { internalFetch, PROCESSOR_URL, VIEWER_URL } from '../utils/api';

// Group messages by grouped_id for album display
const groupMessages = (messages) => {
  if (!messages || messages.length === 0) return [];
  
  console.log(`[useArchiver] Processing ${messages.length} messages for grouping`);
  
  const groups = {};
  const result = [];
  let groupCount = 0;
  let individualCount = 0;
  
  // First pass: collect all messages by group
  const groupMessages = {};
  const individualMessages = [];
  
  for (const message of messages) {
    const groupId = message.grouped_id;
    
    if (groupId) {
      if (!groupMessages[groupId]) {
        groupMessages[groupId] = [];
      }
      groupMessages[groupId].push(message);
    } else {
      individualMessages.push(message);
    }
  }
  
  // Second pass: create group objects with Master Message logic
  for (const [groupId, groupMsgs] of Object.entries(groupMessages)) {
    // CRITICAL: Find the "Master Message" - first message with non-empty text
    let masterMessage = null;
    
    // First, try to find a message with text
    for (const msg of groupMsgs) {
      if (msg.text && msg.text.trim()) {
        masterMessage = msg;
        break;
      }
    }
    
    // If no message has text, use the first message as fallback
    if (!masterMessage) {
      masterMessage = groupMsgs[0];
    }
    
    // Create group object with Master Message as base
    const groupObject = {
      ...masterMessage,
      media_group: groupMsgs,
      isGroup: true,
      isAlbum: true, // Add isAlbum property for UI badge
      groupSize: groupMsgs.length,
      text: masterMessage.text || '',
      originalMessageId: masterMessage.telegram_message_id,
      hasText: !!(masterMessage.text && masterMessage.text.trim()),
      // CRITICAL: Propagate media status and keys from all group members
      media_status: masterMessage.media_status || 'none',
      media_key: masterMessage.media_key || null,
      r2_key: masterMessage.r2_key || masterMessage.media_key || null,
      media_url: masterMessage.media_url || null
    };
    
    console.log(`[useArchiver] Created group ${groupId} with Master Message:`, {
      masterMessageId: masterMessage.telegram_message_id,
      hasText: groupObject.hasText,
      text: groupObject.text,
      groupSize: groupObject.groupSize,
      media_status: groupObject.media_status,
      media_key: groupObject.media_key,
      r2_key: groupObject.r2_key
    });
    
    result.push(groupObject);
    groupCount++;
  }
  
  // Add individual messages
  for (const message of individualMessages) {
    result.push({
      ...message,
      isGroup: false,
      isAlbum: false,
      media_group: []
    });
    individualCount++;
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
    fetchMessages,
    setMessages // For instant UI updates
  } = useMessageStore();
  const { selectedChannel } = useChannelStore();

  // Refs for debouncing/throttling
  const pendingTimeoutRef = useRef(null);
  const isTriggeringRef = useRef(false);

  // Identify pending media messages
  const identifyPendingMessages = useCallback((messages) => {
    if (!messages || !Array.isArray(messages)) return [];
    return messages.filter(msg => msg.media_status === 'pending' && msg.media_type && msg.media_type !== '');
  }, []);

  // Throttled/debounced trigger for pending media
  const triggerPendingMedia = useCallback(async (messages) => {
    if (!messages || isProcessing || isSyncing || isTriggeringRef.current) {
      console.log('[useArchiver] Skipping trigger - processing in progress or already triggering');
      return;
    }

    const pendingMessages = identifyPendingMessages(messages);
    if (pendingMessages.length === 0) {
      console.log('[useArchiver] No pending media to process');
      return;
    }

    console.log(`[useArchiver] Triggering auto-processing for ${pendingMessages.length} pending media items`);

    // Clear any existing timeout
    if (pendingTimeoutRef.current) {
      clearTimeout(pendingTimeoutRef.current);
    }

    // Debounce: wait 500ms before triggering to batch rapid changes
    pendingTimeoutRef.current = setTimeout(async () => {
      isTriggeringRef.current = true;
      try {
        // Use the existing phaseBMediaProcessing but in auto mode
        await phaseBMediaProcessing();
      } catch (error) {
        console.error('[useArchiver] Auto-processing failed:', error);
      } finally {
        isTriggeringRef.current = false;
        pendingTimeoutRef.current = null;
      }
    }, 500);
  }, [isProcessing, isSyncing, identifyPendingMessages, phaseBMediaProcessing]);

  // Targeted processing with chatId and live UI updates
  const triggerTargetedProcessing = useCallback(async (chatId) => {
    if (isProcessing || isSyncing || isTriggeringRef.current) {
      console.log('[useArchiver] Skipping targeted processing - already processing');
      return;
    }

    console.log(`[useArchiver] Starting targeted processing for chatId: ${chatId}`);
    isTriggeringRef.current = true;

    try {
      let processedCount = 0;
      let batchCount = 0;
      const batchSize = 5;
      const maxBatches = 100;

      while (batchCount < maxBatches) {
        batchCount++;

        set({
          syncProgress: batchCount,
          syncStatus: `Phase B: Processing media... (Batch ${batchCount})`
        });

        try {
          const response = await internalFetch(`${PROCESSOR_URL}/process-media?batch=true&size=${batchSize}&chatId=${chatId}`, {
            method: 'POST'
          });

          if (response.status === 401) {
            console.error('[useArchiver] HTTP 401 Unauthorized');
            set({
              syncStatus: 'Error: Telegram credentials missing. Please refresh the page.',
              error: 'Telegram credentials missing. Please refresh the page.'
            });
            break;
          }

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const data = await response.json();
          console.log(`[useArchiver] Batch ${batchCount} response:`, data);

          if (!data || !data.success) {
            throw new Error(data?.error || 'Batch processing failed');
          }

          // Handle FloodWaitError
          if (data.floodWait) {
            console.log(`[useArchiver] FloodWait detected, waiting ${data.floodWait}s`);
            set({
              syncStatus: `Rate limited. Waiting ${data.floodWait} seconds...`
            });
            await new Promise(resolve => setTimeout(resolve, data.floodWait * 1000));
            continue;
          }

          // Live UI updates - immediately update messages state
          if (data.results && data.results.length > 0) {
            const { messages: currentMessages } = get();
            const updatedMessages = currentMessages.map(msg => {
              const result = data.results.find(r => r.messageId === msg.telegram_message_id);
              if (result && result.success && !result.skipped && result.mediaKey) {
                console.log(`[useArchiver] Live update: Message ${msg.telegram_message_id} completed`);
                return {
                  ...msg,
                  media_status: 'completed',
                  media_key: result.mediaKey,
                  r2_key: result.mediaKey,
                  media_url: `${VIEWER_URL}/media/${result.mediaKey}`
                };
              } else if (result && result.skipped) {
                return {
                  ...msg,
                  media_status: result.skipReason?.includes('Non-photo') ? 'skipped_type' :
                               result.skipReason?.includes('large') ? 'skipped_large' : 'skipped'
                };
              }
              return msg;
            });
            set({ messages: updatedMessages });
          }

          processedCount += Number(data.processedCount || 0);
          const remaining = Number(data.remaining || 0);
          const hasMore = remaining > 0;

          if (!hasMore) {
            set({
              syncStatus: `Phase B: All media processing complete! Processed ${processedCount} items.`
            });
            break;
          }

          set({
            syncStatus: `Phase B: Processing media... ${remaining} remaining (Processed: ${processedCount})`
          });

          // Wait before next batch
          await new Promise(resolve => setTimeout(resolve, 800));

        } catch (error) {
          console.error(`[useArchiver] Batch ${batchCount} error:`, error);
          set({
            syncStatus: `Error: Batch ${batchCount} failed - ${error.message}`,
            error: error.message
          });
          break;
        }
      }

    } finally {
      isTriggeringRef.current = false;
      set({ isProcessing: false, isLoading: false });
    }
  }, [isProcessing, isSyncing, get, set, internalFetch, PROCESSOR_URL, VIEWER_URL]);

  // Hook lifecycle logging
  console.log("[useArchiver] Hook initialized. ChannelId:", selectedChannel?.id, "Messages length:", messages.length);

  // Memoized grouped messages
  const groupedMessages = useMemo(() => {
    console.log("[useArchiver] State update: messages length =", messages.length);
    return groupMessages(messages);
  }, [messages]);

  // Load history when channel changes
  useEffect(() => {
    if (selectedChannel && selectedChannel.id) {
      console.log(`[useArchiver] fetchMessages triggered for:`, selectedChannel.id, `(${selectedChannel.title})`);
      console.log(`[useArchiver] Current messages length before fetch:`, messages.length);
      console.log(`[useArchiver] Sync states - isProcessing: ${isProcessing}, isSyncing: ${isSyncing}`);
      
      // CRITICAL: Call fetchMessages immediately when channelId exists, do NOT wait for sync states
      const { setLoading } = useMessageStore.getState();
      setLoading(true);
      console.log(`[useArchiver] Loading state set to true to prevent 'No messages' flash`);
      
      fetchMessages(50, true, selectedChannel.id)
        .then(result => {
          console.log(`[useArchiver] History load result:`, {
            success: result?.success,
            messageCount: result?.messages?.length || 0,
            hasMore: result?.hasMore,
            error: result?.error
          });
          
          if (result?.success) {
            console.log(`[useArchiver] Successfully loaded ${result?.messages?.length || 0} messages`);
          } else {
            console.error(`[useArchiver] Failed to load history:`, result?.error);
          }
        })
        .catch(error => {
          console.error('[useArchiver] Failed to load history:', error);
        })
        .finally(() => {
          setLoading(false);
          console.log(`[useArchiver] Loading state set to false`);
        });
    } else {
      console.log('[useArchiver] No selected channel, skipping history load. Current messages length:', messages.length);
    }
    // CRITICAL: Only depend on selectedChannel?.id, NOT on sync states
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

  // CRITICAL: Stale check for isProcessing state
  useEffect(() => {
    if (isProcessing) {
      const staleTimer = setTimeout(() => {
        console.warn('[useArchiver] isProcessing stuck for 30s, forcing reset');
        const { setProcessing } = useMessageStore.getState();
        setProcessing(false);
      }, 30000);

      return () => clearTimeout(staleTimer);
    }
  }, [isProcessing]);

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
    phaseBMediaProcessing,
    triggerPendingMedia, // Expose for auto-trigger from components
    triggerTargetedProcessing // Expose for targeted processing with chatId
  };
};
