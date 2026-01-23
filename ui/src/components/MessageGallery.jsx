// src/components/MessageGallery.jsx
import React, { useState, useEffect } from 'react';
import { useMessageStore } from '../store/messageStore';
import { useChannelStore } from '../store/channelStore';
import { VIEWER_URL } from '../utils/api';

const MessageGallery = () => {
  const { 
    messages, 
    isLoading, 
    hasMore, 
    fetchMessages 
  } = useMessageStore();
  const { selectedChannel, channels } = useChannelStore();
  
  const [selectedImage, setSelectedImage] = useState(null);

  // Helper to get channel name by ID
  const getChannelName = (id) => {
    if (!channels || !id) return id || 'Unknown';
    const ch = channels.find(c => String(c.id) === String(id));
    return ch ? ch.title : id;
  };

  // Load history on mount when channel changes
  useEffect(() => {
    if (!selectedChannel || !selectedChannel.id) return;
    
    const loadHistory = async () => {
      console.log(`Frontend: Loading history for channel ${selectedChannel.id}`);
      try {
        await fetchMessages(50, true, selectedChannel.id);
      } catch (error) {
        console.error('Frontend: History fetch failed:', error);
      }
    };
    
    loadHistory();
  }, [selectedChannel?.id, fetchMessages]);

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

  // Render media column content
  const renderMediaColumn = (msg) => {
    // 1. Success with URL -> Show button
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

    // 2. Show status based on media_status
    switch (msg.media_status) {
      case 'completed':
        if (msg.r2_key) {
          return (
            <button
              onClick={() => setSelectedImage(`${VIEWER_URL}/media/${msg.r2_key}`)}
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

  // Filter system messages
  const validMessages = messages.filter(msg => {
    const text = msg.text || '';
    return !text.startsWith('[Force Step') && 
           !text.startsWith('[Service Message]');
  });

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
            validMessages.map((msg) => (
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
                  {msg.text || <span className="text-gray-400 dark:text-gray-500 italic">(No text)</span>}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                  {renderMediaColumn(msg)}
                </td>
              </tr>
            ))
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
    </div>
  );
};

export default MessageGallery;
