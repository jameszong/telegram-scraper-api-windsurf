import React, { useEffect } from 'react';
import { useChannelStore } from '../store/channelStore';
import { Button } from './ui/button';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Loader2, Check, Users, Hash } from 'lucide-react';

export const ChannelSelector = () => {
  const { 
    channels, 
    selectedChannel, 
    isLoading, 
    error, 
    fetchChannels, 
    selectChannel 
  } = useChannelStore();
  
  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);
  
  const handleSelectChannel = async (channelId) => {
    await selectChannel(channelId);
  };
  
  if (isLoading && channels.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }
  
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Hash className="w-5 h-5" />
            Select Channel to Archive
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="mb-4 p-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm">
              {error}
            </div>
          )}
          
          {channels.length === 0 && !isLoading ? (
            <div className="text-center py-8">
              <Hash className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Channels Found</h3>
              <p className="text-muted-foreground">
                Make sure you're logged in and have joined at least one channel or group.
              </p>
              <Button onClick={fetchChannels} className="mt-4" variant="outline">
                Refresh
              </Button>
            </div>
          ) : (
            <div className="grid gap-4">
              {channels.map((channel) => (
                <div
                  key={channel.id}
                  className={`border rounded-lg p-4 transition-all cursor-pointer hover:border-primary/50 ${
                    selectedChannel?.id === channel.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border'
                  }`}
                  onClick={() => handleSelectChannel(channel.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10">
                          {channel.type === 'channel' ? (
                            <Hash className="w-5 h-5 text-primary" />
                          ) : (
                            <Users className="w-5 h-5 text-primary" />
                          )}
                        </div>
                        
                        <div className="flex-1">
                          <h4 className="font-semibold">{channel.title}</h4>
                          <div className="flex items-center gap-4 text-sm text-muted-foreground">
                            <span className="capitalize">{channel.type}</span>
                            {channel.username && (
                              <span>@{channel.username}</span>
                            )}
                            {channel.participantsCount > 0 && (
                              <span>{channel.participantsCount.toLocaleString()} members</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      {selectedChannel?.id === channel.id ? (
                        <div className="flex items-center gap-2 text-primary">
                          <Check className="w-5 h-5" />
                          <span className="text-sm font-medium">Selected</span>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline">
                          Select
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              
              {isLoading && (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  <span className="ml-2 text-sm text-muted-foreground">Loading...</span>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      
      {selectedChannel && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold">Selected Channel</h3>
                <p className="text-sm text-muted-foreground">
                  {selectedChannel.title} • {selectedChannel.type}
                </p>
              </div>
              <Button onClick={() => selectChannel(selectedChannel.id)} variant="outline" size="sm">
                Confirm Selection
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
