// src/components/MessageGallery.jsx
import React, { useState, useEffect } from 'react';
import { useMessageStore } from '../store/messageStore';
import { useChannelStore } from '../store/channelStore';
import { useArchiver } from '../hooks/useArchiver';
import ImageGalleryModal from './ImageGalleryModal';
import { VIEWER_URL } from '../utils/api';

const MessageGallery = () => {
  const { 
    isLoading, 
    hasMore, 
    fetchMessages 
  } = useMessageStore();
  const { selectedChannel, channels } = useChannelStore();
  const { messages, isProcessing, isSyncing, syncStatus, startSync } = useArchiver();
  
  const [selectedImage, setSelectedImage] = useState(null);
  const [galleryModal, setGalleryModal] = useState({ isOpen: false, images: [], initialIndex: 0 });

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

  // Helper to render media status
  const renderMediaStatus = (status) => {
    switch (status) {
      case 'pending':
        return (
          <span 
            className="text-yellow-600 dark:text-yellow-400 text-sm" 
            title="Phase B is processing... Please wait"
          >
            ⏳ Queued
          </span>
        );
      case 'processing':
        return (
          <span 
            className="text-blue-500 dark:text-blue-400 text-sm" 
            title="Currently downloading..."
          >
            🔄 Downloading...
          </span>
        );
      case 'skipped_large':
        return (
          <span 
            className="text-gray-500 dark:text-gray-400 text-sm" 
            title=">300KB - File too large for processing"
          >
            ⚠️ Too Large
          </span>
        );
      case 'failed':
        return (
          <span 
            className="text-red-500 dark:text-red-400 text-sm" 
            title="Download failed - will retry"
          >
            ❌ Failed
          </span>
        );
      case 'none':
      default:
        return <span className="text-gray-300 dark:text-gray-600">-</span>;
    }
  };

  // Handle opening gallery modal for groups
  const openGalleryModal = (message, index = 0) => {
    console.log('[MessageGallery] Opening gallery modal:', {
      isGroup: message.isGroup,
      messageId: message.telegram_message_id,
      index
    });
    
    if (message.isGroup && message.media_group) {
      // Filter media_group to only include completed items with media keys
      const completedMedia = message.media_group.filter(m => {
        const fileKey = m.r2_key || m.media_key || m.media?.r2_key;
        return m.media_status === 'completed' && (fileKey || m.media_url);
      });
      
      console.log('[MessageGallery] Group completed media:', {
        totalInGroup: message.media_group.length,
        completedCount: completedMedia.length,
        completedMedia: completedMedia.map(m => ({
          id: m.telegram_message_id,
          media_key: m.media_key,
          r2_key: m.r2_key,
          media_url: m.media_url,
          fileKey: m.r2_key || m.media_key || m.media?.r2_key
        }))
      });
      
      if (completedMedia.length > 0) {
        setGalleryModal({
          isOpen: true,
          images: completedMedia,
          initialIndex: index
        });
      } else {
        console.warn('[MessageGallery] No completed media found in group');
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
      
      // Targeted debugging: Check if media_group items have the expected fields
      if (msg.media_group && msg.media_group.length > 0) {
        const firstMedia = msg.media_group[0];
        console.log('[MessageGallery] First media item in group:', {
          messageId: firstMedia.telegram_message_id,
          media_status: firstMedia.media_status,
          media_key: firstMedia.media_key,
          media_url: firstMedia.media_url,
          allAvailableKeys: Object.keys(firstMedia),
          // Check for alternative field names
          r2_key: firstMedia.r2_key,
          mediaKey: firstMedia.mediaKey,
          r2Key: firstMedia.r2Key
        });
        
        if (!firstMedia.media_key && !firstMedia.media_url) {
          console.warn(`[MessageGallery] Missing media fields in group ${msg.grouped_id}. Available keys:`, Object.keys(firstMedia));
        }
      }
      
      const completedCount = msg.media_group.filter(m => {
        const fileKey = m.r2_key || m.media_key || m.media?.r2_key;
        return m.media_status === 'completed' && (fileKey || m.media_url);
      }).length;
      const totalCount = msg.media_group.length;
      
      console.log('[MessageGallery] Group media status:', {
        completedCount,
        totalCount,
        hasCompletedMedia: completedCount > 0
      });
      
      if (completedCount > 0) {
        return (
          <button
            onClick={() => openGalleryModal(msg, 0)}
            className="px-3 py-1 text-sm text-white bg-green-600 rounded hover:bg-green-700 transition-colors"
          >
            🖼️ {completedCount}/{totalCount} Images
          </button>
        );
      } else {
        // Show processing status for the group
        const firstMedia = msg.media_group.find(m => m.media_status === 'pending' || m.media_status === 'processing');
        if (firstMedia) {
          return renderMediaStatus(firstMedia.media_status);
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
        const fileKey = msg.r2_key || msg.media_key || msg.media?.r2_key;
        
        if (!fileKey && !msg.media_url) {
          console.warn(`[MessageGallery] Missing media fields for message ${msg.telegram_message_id}. Available keys:`, Object.keys(msg));
          console.warn(`[MessageGallery] Full message object for debugging:`, msg);
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
        return renderMediaStatus('pending');
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
                        <span className="text-gray-400 dark:text-gray-500 italic">
                          🖼️ Album ({msg.groupSize} images)
                        </span>
                        {msg.text && (
                          <div className="mt-1 text-gray-600 dark:text-gray-400 text-sm">
                            {msg.text}
                          </div>
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
