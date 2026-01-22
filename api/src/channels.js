import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

export class ChannelsService {
  constructor(env) {
    this.env = env;
    this.apiId = parseInt(env.TELEGRAM_API_ID);
    this.apiHash = env.TELEGRAM_API_HASH;
  }

  async getClient() {
    const sessionString = await this.getSession();
    const session = new StringSession(sessionString || '');
    
    return new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
      retryDelay: 2000,
    });
  }

  async getSession() {
    try {
      const result = await this.env.DB.prepare(
        'SELECT value FROM kv_store WHERE key = ?'
      ).bind('session_string').first();
      
      return result ? result.value : null;
    } catch (error) {
      console.error('Error getting session:', error);
      return null;
    }
  }

  async getChannels() {
    try {
      const client = await this.getClient();
      await client.connect();
      
      // Get all dialogs (chats, channels, groups)
      const dialogs = await client.getDialogs({});
      
      // Filter only channels and groups
      const channels = dialogs
        .filter(dialog => dialog.isChannel || dialog.isGroup)
        .map(dialog => ({
          id: dialog.id,
          title: dialog.title || dialog.name,
          username: dialog.username,
          type: dialog.isChannel ? 'channel' : 'group',
          participantsCount: dialog.participantsCount || 0
        }));

      await client.disconnect();

      return {
        success: true,
        channels
      };
    } catch (error) {
      console.error('Error getting channels:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async selectChannel(channelId) {
    try {
      // Save target channel to D1
      await this.env.DB.prepare(
        'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)'
      ).bind('target_channel_id', channelId.toString()).run();

      return {
        success: true,
        message: 'Channel selected successfully'
      };
    } catch (error) {
      console.error('Error selecting channel:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getTargetChannel() {
    try {
      const result = await this.env.DB.prepare(
        'SELECT value FROM kv_store WHERE key = ?'
      ).bind('target_channel_id').first();
      
      // CRITICAL: Return as string to match DB column type and avoid BigInt issues
      return result ? String(result.value) : null;
    } catch (error) {
      console.error('Error getting target channel:', error);
      return null;
    }
  }

  async getChannelInfo(channelId) {
    try {
      const client = await this.getClient();
      await client.connect();
      
      const channel = await client.getEntity(channelId);
      
      await client.disconnect();

      return {
        id: channel.id,
        title: channel.title,
        username: channel.username,
        type: channel.className === 'Channel' ? 'channel' : 'group',
        participantsCount: channel.participantsCount || 0
      };
    } catch (error) {
      console.error('Error getting channel info:', error);
      return null;
    }
  }
}
