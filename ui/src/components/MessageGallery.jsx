import React, { useEffect, useState } from 'react';
import { useMessageStore } from '../store/messageStore';
import { useChannelStore } from '../store/channelStore';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Loader2, MessageSquare } from 'lucide-react';

// Use environment variable if available, otherwise fallback (for local dev)
const API_BASE = import.meta.env.VITE_API_URL || "https://telegram-archiver-api.iflove29.workers.dev";

export const MessageGallery = () => {
  const { 
    messages, 
    isLoading, 
    hasMore, 
    fetchMessages 
  } = useMessageStore();
  const { selectedChannel } = useChannelStore();
  
  const [loadingMore, setLoadingMore] = useState(false);
  
  // CRITICAL: Filter system messages before any processing
  const validMessages = messages.filter(msg => {
    const text = msg.text || '';
    return !text.startsWith('[Force Step') && 
           !text.startsWith('[Service Message]');
  });
  
  // Debug: Log when messages change
  useEffect(() => {
    console.log('Frontend: Messages updated:', messages.length, 'total, valid:', validMessages.length);
    if (messages.length > 0) {
      console.log('Frontend: First message keys:', Object.keys(messages[0]));
      console.log('Frontend: Sample message:', JSON.stringify(messages[0], null, 2));
      console.log('Frontend: Sample r2_key:', messages[0].r2_key);
      console.log('Frontend: Sample grouped_id:', messages[0].grouped_id);
    }
  }, [messages]);
  
  // Group messages by grouped_id for album support
  const groupMessages = (rawMessages) => {
    // Messages are already filtered at component level
    console.log('Frontend: Starting message grouping with', rawMessages.length, 'valid messages');
    
    const groups = {};
    const result = [];
    
    // Sort messages by date first
    const sortedMessages = [...rawMessages].sort((a, b) => new Date(a.date) - new Date(b.date));
    
    for (const message of sortedMessages) {
      const groupId = message.grouped_id;
      
      console.log(`Frontend: Processing message ${message.id}, grouped_id: ${groupId}, has media: ${!!message.media_url}`);
      
      if (groupId && groupId !== 'null') {
        // This message belongs to a group
        if (!groups[groupId]) {
          groups[groupId] = {
            id: groupId,
            text: null,
            media_urls: [],
            date: message.date,
            telegram_message_id: message.telegram_message_id
          };
          console.log(`Frontend: Created new group ${groupId}`);
        }
        
        // Add media URL if exists
        if (message.media_url) {
          groups[groupId].media_urls.push(message.media_url);
          console.log(`Frontend: Added media URL to group ${groupId}: ${message.media_url}`);
        }
        
        // Set text (caption) - usually from the first message with text
        if (!groups[groupId].text && message.text) {
          groups[groupId].text = message.text;
          console.log(`Frontend: Set caption for group ${groupId}: ${message.text.substring(0, 50)}...`);
        }
      } else {
        // This is a standalone message
        result.push({
          id: message.id,
          text: message.text,
          media_urls: message.media_url ? [message.media_url] : [],
          date: message.date,
          telegram_message_id: message.telegram_message_id
        });
        console.log(`Frontend: Added standalone message ${message.id} with ${message.media_url ? 1 : 0} media items`);
      }
    }
    
    // Add groups to result (sort by date)
    const groupArray = Object.values(groups).sort((a, b) => new Date(a.date) - new Date(b.date));
    
    // Merge groups and standalone messages, then sort by date descending (newest first)
    const finalResult = [...groupArray, ...result].sort((a, b) => new Date(b.date) - new Date(a.date));
    
    console.log(`Frontend: Grouping complete - ${groupArray.length} groups, ${result.length} standalone, total: ${finalResult.length}`);
    
    return finalResult;
  };
  
  const groupedMessages = groupMessages(validMessages);
  
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    
    setLoadingMore(true);
    await fetchMessages(50, false);
    setLoadingMore(false);
  };
  
  const formatTime = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  
  if (isLoading && messages.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }
  
  return (
    <div className="flex flex-col space-y-4 p-4 bg-[#0e1621] min-h-screen">
      {/* Header */}
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-white mb-2">
          {selectedChannel?.title || 'Select a channel'}
        </h1>
        <p className="text-[#8b92a8] text-sm">
          {messages.length} messages archived
        </p>
      </div>
      
      {/* Messages */}
      {messages.length === 0 ? (
        <Card className="bg-[#182533] border-[#0e1621]">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <MessageSquare className="w-16 h-16 text-[#64b5ef] mb-4" />
            <h3 className="text-lg font-semibold text-white mb-2">No Archived Messages</h3>
            <p className="text-[#8b92a8] text-center max-w-md">
              This channel hasn't been synced yet. Click "Sync Now" in the header to start archiving messages.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col space-y-4 max-w-2xl mx-auto w-full">
          {groupedMessages.map((group) => (
            <div key={group.id} className="flex justify-start">
              <div className="bg-[#182533] p-3 rounded-lg rounded-tl-none max-w-[80%] shadow-md border border-[#0e1621]">
                
                {/* Image Grid for Albums */}
                {group.media_urls.length > 0 && (
                  <div className={`grid gap-1 mb-2 ${
                    group.media_urls.length === 1 ? 'grid-cols-1' : 
                    group.media_urls.length === 2 ? 'grid-cols-2' : 
                    'grid-cols-3'
                  }`}>
                    {group.media_urls.map((url, index) => (
                      <img 
                        key={`${url}-${index}`}
                        src={url} 
                        alt="Attachment" 
                        className="object-cover w-full h-32 rounded-sm cursor-pointer hover:opacity-90 transition-opacity"
                        loading="lazy"
                        onError={(e) => {
                          console.error('Frontend: Image load failed:', e.target.src);
                          e.target.style.display = 'none'; // Hide broken images
                        }}
                        onLoad={(e) => {
                          console.log('Frontend: Image loaded successfully:', e.target.src);
                        }}
                      />
                    ))}
                  </div>
                )}

                {/* Text Rendering (Pre-wrap to keep newlines) */}
                {group.text && (
                  <p className="text-white text-[15px] whitespace-pre-wrap leading-snug break-words mb-2">
                    {group.text}
                  </p>
                )}

                {/* Footer: Date */}
                <div className="text-right">
                  <span className="text-[#6c7883] text-xs">
                    {formatTime(group.date)}
                  </span>
                </div>
              </div>
            </div>
          ))}
          
          {/* Load More Button */}
          {hasMore && (
            <div className="flex justify-center mt-6">
              <Button
                onClick={loadMore}
                disabled={loadingMore}
                variant="outline"
                className="bg-[#182533] border-[#0e1621] text-white hover:bg-[#1a2b47]"
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  'Load More Messages'
                )}
              </Button>
            </div>
          )}
          
          {/* End of Archive */}
          {!hasMore && validMessages.length > 0 && (
            <div className="text-center py-8">
              <p className="text-[#8b92a8] text-sm">
                End of archive • {validMessages.length} messages total
              </p>
            </div>
          )}
          
          {/* Loading More Indicator */}
          {loadingMore && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-[#64b5ef]" />
              <span className="ml-2 text-sm text-[#8b92a8]">Loading more messages...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
