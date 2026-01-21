import React, { useEffect, useState } from 'react';
import { useMessageStore } from '../store/messageStore';
import { useChannelStore } from '../store/channelStore';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Loader2, Image, FileText, Calendar, MessageSquare, Download } from 'lucide-react';

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
  
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    
    setLoadingMore(true);
    await fetchMessages(50, false);
    setLoadingMore(false);
  };
  
  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };
  
  const renderMedia = (message) => {
    if (!message.r2_key) return null;
    
    const mediaUrl = `${API_BASE}/media/${message.r2_key}`;
    
    if (message.file_type === 'photo') {
      return (
        <div className="rounded-lg overflow-hidden bg-muted/20">
          <img
            src={mediaUrl}
            alt="Telegram media"
            className="w-full h-auto max-h-64 object-cover"
            loading="lazy"
          />
        </div>
      );
    }
    
    if (message.file_type === 'document') {
      return (
        <a
          href={mediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 p-3 rounded-lg border bg-muted/20 hover:bg-muted/30 transition-colors"
        >
          <FileText className="w-8 h-8 text-primary" />
          <div className="flex-1">
            <p className="text-sm font-medium">Document</p>
            <p className="text-xs text-muted-foreground">
              {message.mime_type || 'Unknown type'}
            </p>
          </div>
          <Download className="w-4 h-4" />
        </a>
      );
    }
    
    return null;
  };
  
  if (isLoading && messages.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }
  
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Archive</h2>
          <p className="text-muted-foreground">
            {messages.length} messages from {selectedChannel?.title}
          </p>
        </div>
        
        {hasMore && (
          <Button
            onClick={loadMore}
            disabled={loadingMore}
            variant="outline"
          >
            {loadingMore ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Loading...
              </>
            ) : (
              'Load More'
            )}
          </Button>
        )}
      </div>
      
      {/* Messages Grid */}
      {messages.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <MessageSquare className="w-16 h-16 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Archived Messages</h3>
            <p className="text-muted-foreground text-center max-w-md">
              This channel hasn't been synced yet. Click "Sync Now" in the header to start archiving messages.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {messages.map((message, index) => (
            <Card key={`${message.telegram_message_id}-${index}`}>
              <CardContent className="p-6">
                <div className="space-y-4">
                  {/* Message Header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <Calendar className="w-4 h-4" />
                      <span>{formatDate(message.date)}</span>
                      <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded">
                        ID: {message.telegram_message_id}
                      </span>
                    </div>
                    
                    {message.file_type && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        {message.file_type === 'photo' ? (
                          <Image className="w-3 h-3" />
                        ) : (
                          <FileText className="w-3 h-3" />
                        )}
                        <span className="capitalize">{message.file_type}</span>
                      </div>
                    )}
                  </div>
                  
                  {/* Message Text */}
                  {message.text && (
                    <div className="prose prose-sm max-w-none dark:prose-invert">
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">
                        {message.text}
                      </p>
                    </div>
                  )}
                  
                  {/* Media Content */}
                  {message.r2_key && renderMedia(message)}
                </div>
              </CardContent>
            </Card>
          ))}
          
          {loadingMore && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <span className="ml-2 text-sm text-muted-foreground">Loading more messages...</span>
            </div>
          )}
          
          {!hasMore && messages.length > 0 && (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground">
                End of archive • {messages.length} messages total
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
