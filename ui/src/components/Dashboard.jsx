import React, { useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { useChannelStore } from '../store/channelStore';
import { useMessageStore } from '../store/messageStore';
import { ChannelSelector } from './ChannelSelector';
import MessageGallery from './MessageGallery';
import { Button } from './ui/button';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { LogOut, RefreshCw, Loader2, Hash, Archive } from 'lucide-react';

export const Dashboard = () => {
  const { logout, isLoggedIn } = useAuthStore();
  const { 
    channels, 
    selectedChannel, 
    fetchChannels, 
    initializeFromStorage,
    isLoading: channelsLoading 
  } = useChannelStore();
  const { 
    syncMessages, 
    isSyncing,
    syncProgress,
    syncStatus,
    fetchMessages,
    isLoading: messagesLoading 
  } = useMessageStore();
  
  const [activeTab, setActiveTab] = useState('channels');
  
  useEffect(() => {
    if (isLoggedIn) {
      fetchChannels();
    }
  }, [isLoggedIn, fetchChannels]);
  
  useEffect(() => {
    if (channels.length > 0) {
      // Initialize selected channel from localStorage after channels are loaded
      initializeFromStorage();
    }
  }, [channels, initializeFromStorage]);
  
  useEffect(() => {
    if (selectedChannel) {
      console.log('Debug: Channel switched to:', selectedChannel.id, selectedChannel.title);
      fetchMessages(50, true, selectedChannel.id);
    }
  }, [selectedChannel?.id, fetchMessages]); // Use selectedChannel?.id for better reactivity
  
  const handleSync = async () => {
    if (!selectedChannel) return;
    
    try {
      const result = await syncMessages();
      if (result && result.success) {
        // Messages will be automatically refreshed after sync
      }
    } catch (error) {
      console.error('[Dashboard] Sync failed:', error);
    }
  };
  
  const handleLogout = () => {
    logout();
  };
  
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Archive className="w-8 h-8 text-primary" />
              <div>
                <h1 className="text-2xl font-bold">Telegram Archiver</h1>
                <p className="text-sm text-muted-foreground">
                  {selectedChannel ? `Archiving: ${selectedChannel.title}` : 'Select a channel to start'}
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-4">
              {selectedChannel && (
                <div className="flex items-center gap-2">
                  <Button 
                    onClick={handleSync} 
                    disabled={isSyncing}
                    variant="outline"
                  >
                    {isSyncing ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        {syncProgress > 0 ? `${syncProgress}/10` : 'Syncing...'}
                      </>
                    ) : (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Sync Now
                      </>
                    )}
                  </Button>
                  
                  {syncStatus && (
                    <span className="text-sm text-muted-foreground">
                      {syncStatus}
                    </span>
                  )}
                </div>
              )}
              
              <Button onClick={handleLogout} variant="ghost">
                <LogOut className="w-4 h-4 mr-2" />
                Logout
              </Button>
            </div>
          </div>
        </div>
      </header>
      
      {/* Navigation Tabs */}
      <div className="border-b bg-card/50">
        <div className="container mx-auto px-4">
          <nav className="flex space-x-8">
            <button
              onClick={() => setActiveTab('channels')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'channels'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <div className="flex items-center gap-2">
                <Hash className="w-4 h-4" />
                Channels
              </div>
            </button>
            
            <button
              onClick={() => setActiveTab('archive')}
              disabled={!selectedChannel}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'archive'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              } ${!selectedChannel ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <div className="flex items-center gap-2">
                <Archive className="w-4 h-4" />
                Archive
              </div>
            </button>
          </nav>
        </div>
      </div>
      
      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {activeTab === 'channels' && (
          <ChannelSelector />
        )}
        
        {activeTab === 'archive' && selectedChannel && (
          <MessageGallery />
        )}
        
        {activeTab === 'archive' && !selectedChannel && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Hash className="w-16 h-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Channel Selected</h3>
              <p className="text-muted-foreground text-center max-w-md">
                Please select a channel from the Channels tab to view its archived messages.
              </p>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
};
