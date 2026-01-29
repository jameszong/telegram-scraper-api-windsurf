// src/components/MessageGallery.jsx
import React, { useState, useEffect } from 'react';
import { useMessageStore } from '../store/messageStore';
import { useChannelStore } from '../store/channelStore';
import { useArchiver } from '../hooks/useArchiver';
import ImageGalleryModal from './ImageGalleryModal';
import { VIEWER_URL, PROCESSOR_URL, internalFetch } from '../utils/api';

const MessageGallery = () => {
  const { 
    isLoading, 
    hasMore, 
    fetchMessages 
  } = useMessageStore();
  const { selectedChannel, channels } = useChannelStore();
  const { 
    messages, // This is already grouped messages from useArchiver
    isProcessing, 
    isSyncing, 
    syncStatus, 
    startSync, 
    triggerPendingMedia, 
    triggerTargetedProcessing 
  } = useArchiver();
  
  // CRITICAL FIX: Get raw messages for gallery modal search (not grouped ones)
  const rawMessages = useMessageStore(state => state.messages);
  
  const [selectedImage, setSelectedImage] = useState(null);
  const [galleryModal, setGalleryModal] = useState({ isOpen: false, images: [], initialIndex: 0 });
  const [loadingMore, setLoadingMore] = useState(false);
  const [downloadingMedia, setDownloadingMedia] = useState({}); // Track downloading state per message

  // Helper to get channel name by ID
  const getChannelName = (id) => {
    if (!channels || !id) return id || 'Unknown';
    const ch = channels.find(c => String(c.id) === String(id));
    return ch ? ch.title : id;
  };

  // Format date timestamp
  const formatDate = (dateString) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  // Handle keyboard ESC to close modal
  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') setSelectedImage(null);
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, []);

  // REMOVED: Auto-trigger processing (ON-DEMAND architecture)
  // Users must click "📥 点击下载" to download specific images
  // No automatic batch processing to prevent FloodWait errors

  // Helper to render media status
  const renderMediaStatus = (status) => {
    switch (status) {
      case 'pending':
        return (
          <span 
            className="text-yellow-600 dark:text-yellow-400 text-sm" 
            title="Phase B is processing... Please wait"
          >
            ⏳ Pending
          </span>
        );
      case 'processing':
        return (
          <span 
            className="text-blue-600 dark:text-blue-400 text-sm" 
            title="Currently processing..."
          >
            🔄 Processing
          </span>
        );
      case 'completed':
        return (
          <span 
            className="text-green-600 dark:text-green-400 text-sm" 
            title="Processing complete"
          >
            ✅ Completed
          </span>
        );
      case 'skipped_large':
        return (
          <span 
            className="text-orange-600 dark:text-orange-400 text-sm" 
            title="File too large (>300KB)"
          >
            🚫 Too Large
          </span>
        );
      case 'skipped_type':
        return (
          <span 
            className="text-purple-600 dark:text-purple-400 text-sm" 
            title="Not an image (video, document, etc.)"
          >
            🚫 Not Image
          </span>
        );
      case 'skipped':
        return (
          <span 
            className="text-gray-600 dark:text-gray-400 text-sm" 
            title="Skipped (no media or unsupported)"
          >
            🚫 Skipped
          </span>
        );
      case 'failed':
        return (
          <span 
            className="text-red-600 dark:text-red-400 text-sm" 
            title="Processing failed"
          >
            ❌ Failed
          </span>
        );
      default:
        return (
          <span 
            className="text-gray-400 dark:text-gray-500 text-sm" 
            title="No media"
          >
            📄 None
          </span>
        );
    }
  };

  // Handle pagination - Next page
  const handleNextPage = async () => {
    if (!selectedChannel || loadingMore || isLoading || !hasMore) return;
    
    console.log('[MessageGallery] Loading next page for channel:', selectedChannel.id);
    
    try {
      setLoadingMore(true);
      // Just fetch next 10 messages from DB (they should already be synced)
      await fetchMessages(10, false, selectedChannel.id); // Append next 10
    } catch (error) {
      console.error('[MessageGallery] Error loading next page:', error);
    } finally {
      setLoadingMore(false);
    }
  };
  
  // Handle pagination - Previous page
  const handlePreviousPage = () => {
    // For now, we'll just show a message that previous page is not supported
    // In a real implementation, you'd need to track page state
    console.log('[MessageGallery] Previous page not implemented yet');
  };

  // ON-DEMAND: Download media for a specific message
  const downloadMediaOnDemand = async (message) => {
    const messageKey = `${message.chat_id}_${message.telegram_message_id}`;
    
    // Prevent duplicate requests
    if (downloadingMedia[messageKey]) {
      console.log(`[ON-DEMAND] Already downloading ${messageKey}`);
      return;
    }
    
    setDownloadingMedia(prev => ({ ...prev, [messageKey]: true }));
    
    try {
      console.log(`[ON-DEMAND] Downloading media for message ${message.telegram_message_id}`);
      
      const response = await internalFetch(`${PROCESSOR_URL}/download-media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.telegram_message_id,
          chatId: message.chat_id
        })
      });
      
      const data = await response.json();
      
      if (data.success) {
        console.log(`[ON-DEMAND] Download successful:`, data);
        
        // Update message store with new media_key
        const { setMessages } = useMessageStore.getState();
        const currentMessages = useMessageStore.getState().messages;
        
        const updatedMessages = currentMessages.map(msg => {
          if (String(msg.telegram_message_id) === String(message.telegram_message_id) &&
              String(msg.chat_id) === String(message.chat_id)) {
            return {
              ...msg,
              media_status: 'completed',
              media_key: data.mediaKey,
              media_url: `${VIEWER_URL.replace('/api', '')}/r2/${data.mediaKey}`
            };
          }
          return msg;
        });
        
        setMessages(updatedMessages);
        
        // Refresh the display
        await fetchMessages(50, true, selectedChannel.id);
        
        return data.mediaKey;
      } else {
        console.error(`[ON-DEMAND] Download failed:`, data.error);
        alert(`下载失败: ${data.error || '未知错误'}`);
        return null;
      }
    } catch (error) {
      console.error(`[ON-DEMAND] Download error:`, error);
      alert(`下载出错: ${error.message}`);
      return null;
    } finally {
      setDownloadingMedia(prev => ({ ...prev, [messageKey]: false }));
    }
  };

  // Handle opening gallery modal for groups
  const openGalleryModal = (message, index = 0) => {
    console.log('[MessageGallery] Opening gallery modal:', {
      isGroup: message.isGroup,
      messageId: message.telegram_message_id,
      grouped_id: message.grouped_id,
      grouped_id_type: typeof message.grouped_id,
      index
    });
    
    // CRITICAL FIX: Use raw messages for searching grouped siblings (not grouped display messages)
    const allMessages = rawMessages;
    
    console.log(`[Gallery Debug] Searching in ${allMessages.length} total messages for GroupID: ${message.grouped_id}`);
    
    // STRICT FIELD INSPECTION: Validate data quality
    const dataValidation = {
      totalMessages: allMessages.length,
      messagesWithGroupId: 0,
      messagesWithMediaKey: 0,
      messagesCompleted: 0,
      messagesPending: 0,
      missingFields: []
    };
    
    allMessages.forEach((msg, idx) => {
      if (msg.grouped_id) dataValidation.messagesWithGroupId++;
      if (msg.media_key || msg.r2_key) dataValidation.messagesWithMediaKey++;
      if (msg.media_status === 'completed') dataValidation.messagesCompleted++;
      if (msg.media_status === 'pending') dataValidation.messagesPending++;
      
      // Alert on missing critical fields
      if (idx < 5 && msg.grouped_id && msg.media_status === 'completed' && !msg.media_key && !msg.r2_key) {
        console.warn(`[Data Alert] Msg ${msg.telegram_message_id} marked completed but NO media_key!`, {
          media_status: msg.media_status,
          media_key: msg.media_key,
          r2_key: msg.r2_key,
          grouped_id: msg.grouped_id,
          allKeys: Object.keys(msg)
        });
        dataValidation.missingFields.push(msg.telegram_message_id);
      }
      
      // Type check grouped_id
      if (idx < 5 && msg.grouped_id && typeof msg.grouped_id !== 'string') {
        console.warn(`[Type Alert] Msg ${msg.telegram_message_id} grouped_id is not String:`, {
          grouped_id: msg.grouped_id,
          type: typeof msg.grouped_id
        });
      }
    });
    
    console.log(`[Gallery Debug] Data Validation:`, dataValidation);
    
    // Check if this message has a grouped_id (Telegram album)
    if (message.grouped_id) {
      // CRITICAL FIX: Force String comparison to defend against BigInt precision loss
      const targetGroupId = String(message.grouped_id);
      
      // ROBUST FILTER: Trust media_key existence over media_status
      // Reason: Legacy data may have media_key but stuck status
      const allSiblings = allMessages.filter(m => {
        const mGroup = String(m.grouped_id || '');
        return mGroup === targetGroupId;
      });
      
      // Log sibling statuses for debugging
      console.log('[Gallery Debug] Sibling statuses:', {
        totalSiblings: allSiblings.length,
        statuses: allSiblings.map(s => ({
          id: s.telegram_message_id,
          status: s.media_status,
          has_media_key: !!(s.media_key || s.r2_key),
          media_key: s.media_key,
          r2_key: s.r2_key
        }))
      });
      
      const groupMessages = allSiblings.filter(m => {
        // CRITICAL: Trust media_key existence, not status
        // If media_key exists, the image IS in R2
        const hasValidMedia = (m.media_key && m.media_key.length > 0) || 
                             (m.r2_key && m.r2_key.length > 0) || 
                             (m.media_url && m.media_url.length > 0);
        
        return hasValidMedia;
      });
      
      // Sort them by telegram_message_id to maintain order
      groupMessages.sort((a, b) => Number(a.telegram_message_id) - Number(b.telegram_message_id));
      
      console.log('[Gallery Debug] Found grouped images:', {
        grouped_id: message.grouped_id,
        targetGroupId,
        targetGroupId_type: typeof targetGroupId,
        totalInGroup: groupMessages.length,
        allMessagesWithGroupId: allMessages.filter(m => String(m.grouped_id || '') === targetGroupId).length,
        messagesWithMedia: allMessages.filter(m => 
          String(m.grouped_id || '') === targetGroupId && (m.media_key || m.r2_key || m.media_url)
        ).length,
        completedMessages: allMessages.filter(m => 
          String(m.grouped_id || '') === targetGroupId && m.media_status === 'completed'
        ).length,
        groupMessages: groupMessages.map(m => ({
          id: m.telegram_message_id,
          media_status: m.media_status,
          media_key: m.media_key,
          r2_key: m.r2_key,
          media_url: m.media_url,
          fileKey: m.r2_key || m.media_key || m.media?.r2_key
        }))
      });
      
      if (groupMessages.length > 0) {
        // Find the index of the currently clicked image
        const currentIndex = groupMessages.findIndex(m => 
          String(m.telegram_message_id) === String(message.telegram_message_id)
        );
        
        console.log('[Gallery Debug] Opening gallery with:', {
          totalImages: groupMessages.length,
          currentIndex: currentIndex >= 0 ? currentIndex : 0,
          clickedMessageId: message.telegram_message_id
        });
        
        setGalleryModal({
          isOpen: true,
          images: groupMessages,
          initialIndex: currentIndex >= 0 ? currentIndex : 0
        });
      } else {
        console.warn('[Gallery Debug] No completed media found for grouped_id:', {
          grouped_id: message.grouped_id,
          targetGroupId,
          totalMessagesInGroup: allMessages.filter(m => String(m.grouped_id || '') === targetGroupId).length,
          messagesWithMedia: allMessages.filter(m => 
            String(m.grouped_id || '') === targetGroupId && (m.media_key || m.r2_key || m.media_url)
          ).length,
          completedMessages: allMessages.filter(m => 
            String(m.grouped_id || '') === targetGroupId && m.media_status === 'completed'
          ).length,
          // Debug: Show first few messages with this group_id for inspection
          sampleMessages: allMessages.filter(m => String(m.grouped_id || '') === targetGroupId).slice(0, 3).map(m => ({
            id: m.telegram_message_id,
            media_status: m.media_status,
            hasMedia: !!(m.media_key || m.r2_key || m.media_url),
            grouped_id: m.grouped_id,
            grouped_id_type: typeof m.grouped_id
          }))
        });
      }
    } else {
      const fileKey = message.r2_key || message.media_key || message.media?.r2_key;
      if (fileKey || message.media_url) {
        // Single image
        console.log('[MessageGallery] Opening single image modal:', {
          messageId: message.telegram_message_id,
          fileKey,
          media_url: message.media_url,
          r2_key: message.r2_key,
          media_key: message.media_key
        });
        
        setGalleryModal({
          isOpen: true,
          images: [message],
          initialIndex: 0
        });
      } else {
        console.warn('[MessageGallery] No media available for modal:', {
          messageId: message.telegram_message_id,
          media_status: message.media_status,
          r2_key: message.r2_key,
          media_key: message.media_key,
          media_url: message.media_url
        });
      }
    }
  };

  // Render media column content
  const renderMediaColumn = (msg) => {
    // 1. Success with URL -> Show button (legacy support)
    if (msg.media_url) {
      return (
        <button
          onClick={() => setSelectedImage(msg.media_url)}
          className="px-3 py-1 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors"
        >
          📷 View Image
        </button>
      );
    }

    // 2. Handle grouped messages
    if (msg.isGroup) {
      console.log('[MessageGallery] Processing group message:', {
        groupId: msg.grouped_id,
        groupSize: msg.groupSize,
        media_group: msg.media_group
      });
      
      // CRITICAL FIX: Count completed media across ALL sibling messages with the same grouped_id
      const allMessages = rawMessages;
      const groupedIdStr = String(msg.grouped_id); // BigInt safety: cast to string
      
      // Find all messages with the same grouped_id
      const siblingMessages = allMessages.filter(sibling => {
        const siblingGroupIdStr = String(sibling.grouped_id || '');
        return siblingGroupIdStr === groupedIdStr;
      });
      
      // Aggregate media from all siblings - ROBUST FILTER
      let totalCompletedCount = 0;
      let totalMediaCount = 0;
      
      siblingMessages.forEach(sibling => {
        if (sibling.media_group && Array.isArray(sibling.media_group)) {
          totalMediaCount += sibling.media_group.length;
          // ROBUST: Trust media_key existence over status
          const completedInSibling = sibling.media_group.filter(m => {
            const fileKey = m.media_key || m.r2_key || m.media?.r2_key || m.media?.media_key;
            return fileKey && fileKey.length > 0;
          });
          totalCompletedCount += completedInSibling.length;
        } else if (sibling.media_status !== 'none' && sibling.media_status !== null) {
          totalMediaCount += 1;
          // ROBUST: Trust media_key existence over status
          const fileKey = sibling.media_key || sibling.r2_key || sibling.media?.r2_key || sibling.media?.media_key;
          if (fileKey && fileKey.length > 0) {
            totalCompletedCount += 1;
          }
        }
      });
      
      console.log('[MessageGallery] Group media aggregation:', {
        groupedId: groupedIdStr,
        siblingMessages: siblingMessages.length,
        totalMediaCount,
        totalCompletedCount,
        hasCompletedMedia: totalCompletedCount > 0
      });
      
      if (totalCompletedCount > 0) {
        return (
          <button
            onClick={() => openGalleryModal(msg, 0)}
            className="px-3 py-1 text-sm text-white bg-green-600 rounded hover:bg-green-700 transition-colors"
          >
            🖼️ {totalCompletedCount}/{totalMediaCount} Images
          </button>
        );
      } else {
        // Show download button for pending group - check any sibling for status
        let hasPending = false;
        let hasProcessing = false;
        
        for (const sibling of siblingMessages) {
          if (sibling.media_group && Array.isArray(sibling.media_group)) {
            const firstPending = sibling.media_group.find(m => 
              m.media_status === 'pending' || m.media_status === 'processing'
            );
            if (firstPending) {
              if (firstPending.media_status === 'pending') hasPending = true;
              if (firstPending.media_status === 'processing') hasProcessing = true;
              break;
            }
          } else if (sibling.media_status === 'pending') {
            hasPending = true;
            break;
          } else if (sibling.media_status === 'processing') {
            hasProcessing = true;
            break;
          }
        }
        
        // CRITICAL FIX: Show download button for pending groups
        if (hasPending) {
          const messageKey = `${msg.chat_id}_${msg.telegram_message_id}`;
          const isDownloading = downloadingMedia[messageKey];
          
          return (
            <button
              onClick={() => downloadMediaOnDemand(msg)}
              disabled={isDownloading}
              className={`px-3 py-1 text-sm text-white rounded transition-colors ${
                isDownloading 
                  ? 'bg-gray-400 cursor-not-allowed' 
                  : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              {isDownloading ? '⏳ 下载中...' : '📥 点击下载'}
            </button>
          );
        }
        
        if (hasProcessing) {
          return renderMediaStatus('processing');
        }
        
        return <span className="text-gray-300 dark:text-gray-600">-</span>;
      }
    }

    // 3. Show status based on media_status (individual messages)
    switch (msg.media_status) {
      case 'completed':
        console.log('[MessageGallery] Individual completed message:', {
          messageId: msg.telegram_message_id,
          media_status: msg.media_status,
          media_key: msg.media_key,
          media_url: msg.media_url,
          // Targeted debugging: Log all available keys if media fields are missing
          allAvailableKeys: Object.keys(msg),
          // Check for alternative field names that might contain the media key
          r2_key: msg.r2_key,
          mediaKey: msg.mediaKey,
          r2Key: msg.r2Key,
          file_key: msg.file_key,
          fileKey: msg.fileKey
        });
        
        // If expected fields are missing, log all keys to find the correct one
        const fileKey = msg.media_key || msg.r2_key || msg.media?.r2_key || msg.media?.media_key;
        
        if (!fileKey && !msg.media_url) {
          // 只在非 pending 状态时警告，因为 pending 状态下缺少 media_key 是正常的
          if (msg.media_status !== 'pending') {
            console.warn(`[MessageGallery] Missing media fields for message ${msg.telegram_message_id}. Available keys:`, Object.keys(msg));
            console.warn(`[MessageGallery] Full message object for debugging:`, msg);
          }
        }
        
        if (fileKey || msg.media_url) {
          console.log('[MessageGallery] Found media key for message:', {
            messageId: msg.telegram_message_id,
            fileKey,
            media_url: msg.media_url,
            r2_key: msg.r2_key,
            media_key: msg.media_key
          });
          
          return (
            <button
              onClick={() => openGalleryModal(msg, 0)}
              className="px-3 py-1 text-sm text-white bg-green-600 rounded hover:bg-green-700 transition-colors"
            >
              📷 View Image
            </button>
          );
        }
        return (
          <span className="text-green-500 dark:text-green-400 text-sm">
            ✅ Completed
          </span>
        );
      case 'pending':
        // ON-DEMAND: Show download button for pending media
        const messageKey = `${msg.chat_id}_${msg.telegram_message_id}`;
        const isDownloading = downloadingMedia[messageKey];
        
        return (
          <button
            onClick={() => downloadMediaOnDemand(msg)}
            disabled={isDownloading}
            className={`px-3 py-1 text-sm text-white rounded transition-colors ${
              isDownloading 
                ? 'bg-gray-400 cursor-not-allowed' 
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {isDownloading ? '⏳ 下载中...' : '📥 点击下载'}
          </button>
        );
      case 'processing':
        return renderMediaStatus('processing');
      case 'skipped_large':
        return renderMediaStatus('skipped_large');
      case 'failed':
        return renderMediaStatus('failed');
      case 'none':
      default:
        return renderMediaStatus('none');
    }
  };

  // Filter system messages
  const validMessages = messages.filter(msg => {
    const text = msg.text || '';
    return !text.startsWith('[Force Step') && 
           !text.startsWith('[Service Message]');
  });

  // Debug: Log grouping transformation
  console.log("[MessageList] Pre-grouping count:", messages.length);
  console.log("[MessageList] Post-filtering count:", validMessages.length);
  
  // Check for grouped messages that should be grouped but aren't
  const messagesWithGroupedId = messages.filter(msg => msg.grouped_id);
  console.log("[MessageList] Messages with grouped_id:", messagesWithGroupedId.length);
  
  if (messagesWithGroupedId.length > 0) {
    console.log("[MessageList] Sample grouped_id values:", 
      messagesWithGroupedId.slice(0, 3).map(msg => ({
        id: msg.telegram_message_id,
        grouped_id: msg.grouped_id,
        grouped_id_type: typeof msg.grouped_id,
        isGroup: msg.isGroup
      }))
    );
  }

  return (
    <div className="overflow-x-auto bg-white dark:bg-zinc-900 shadow rounded-lg">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-zinc-800">
        <thead className="bg-gray-50 dark:bg-zinc-800">
          <tr>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider w-24">
              ID
            </th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider w-32">
              Channel
            </th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider w-40">
              Time
            </th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Content
            </th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider w-32">
              Media
            </th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-zinc-900 divide-y divide-gray-200 dark:divide-zinc-800">
          {isLoading && validMessages.length === 0 ? (
            <tr>
              <td colSpan="5" className="px-6 py-4 text-center text-gray-500 dark:text-gray-400">
                Loading...
              </td>
            </tr>
          ) : validMessages.length === 0 ? (
            <tr>
              <td colSpan="5" className="px-6 py-4 text-center text-gray-500 dark:text-gray-400">
                No messages (Select channel or click Sync)
              </td>
            </tr>
          ) : (
            validMessages.map((msg) => {
              // Fallback UI: Check for grouped messages that should be grouped but aren't
              if (msg.grouped_id && !msg.isGroup) {
                console.warn("[MessageList] Fallback: Message has grouped_id but not grouped:", {
                  id: msg.telegram_message_id,
                  grouped_id: msg.grouped_id,
                  grouped_id_type: typeof msg.grouped_id,
                  text: msg.text?.substring(0, 50) + '...'
                });
              }
              
              return (
                <tr key={msg.id} className="hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                    {msg.telegram_message_id}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                    {getChannelName(msg.chat_id)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                    {formatDate(msg.date)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-xl break-words">
                    {msg.isGroup ? (
                      <div>
                        {/* CRITICAL: Show actual text first, then album badge */}
                        {msg.text ? (
                          <div>
                            <span className="text-gray-900 dark:text-gray-100">
                              {msg.text}
                            </span>
                            {msg.isAlbum && (
                              <span className="ml-2 text-gray-400 dark:text-gray-500 italic text-sm">
                                🖼️ Album (+{msg.groupSize})
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-500 italic">
                            🖼️ Album ({msg.groupSize} images)
                          </span>
                        )}
                      </div>
                    ) : (
                      msg.text || <span className="text-gray-400 dark:text-gray-500 italic">(No text)</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    {renderMediaColumn(msg)}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {/* Pagination Controls */}
      {validMessages.length > 0 && (
        <div className="p-4 text-center border-t">
          <div className="flex items-center justify-center gap-4">
            <button
              onClick={handleNextPage}
              disabled={loadingMore || isLoading || !hasMore}
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {loadingMore ? (
                <>
                  <span className="inline-block animate-spin mr-2">⏳</span>
                  加载中...
                </>
              ) : (
                <>
                  下一页 (10条) →
                </>
              )}
            </button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            当前显示 {validMessages.length} 条消息 {hasMore ? '· 点击下一页加载更多' : '· 已全部加载'}
          </p>
        </div>
      )}

      {/* Image Preview Modal */}
      {selectedImage && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-75 p-4"
          onClick={() => setSelectedImage(null)}
        >
          <div className="relative max-w-full max-h-full">
            <button
              className="absolute -top-10 right-0 text-white text-xl font-bold hover:text-gray-300"
              onClick={() => setSelectedImage(null)}
            >
              Close [ESC]
            </button>
            <img
              src={selectedImage}
              alt="Full size"
              className="max-w-full max-h-[90vh] object-contain rounded shadow-lg"
              onClick={(e) => e.stopPropagation()} // Prevent closing on image click
            />
          </div>
        </div>
      )}
      
      {/* Gallery Modal for grouped images */}
      <ImageGalleryModal
        isOpen={galleryModal.isOpen}
        onClose={() => setGalleryModal({ isOpen: false, images: [], initialIndex: 0 })}
        images={galleryModal.images}
        initialIndex={galleryModal.initialIndex}
      />
    </div>
  );
};

export default MessageGallery;
