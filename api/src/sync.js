import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

export class SyncService {
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

  async syncMessages() {
    try {
      const session = await this.getSession();
      const targetChannelId = await this.getTargetChannel();

      if (!session) {
        return { success: false, error: 'No active session found' };
      }

      if (!targetChannelId) {
        return { success: false, error: 'No target channel selected' };
      }

      const client = await this.getClient();
      await client.connect();

      // Get the channel entity
      const channel = await client.getEntity(targetChannelId);
      
      // Get the last message ID from our database to avoid duplicates
      const lastMessage = await this.env.DB.prepare(
        'SELECT telegram_message_id FROM messages WHERE chat_id = ? ORDER BY telegram_message_id DESC LIMIT 1'
      ).bind(targetChannelId).first();

      const offsetId = lastMessage ? lastMessage.telegram_message_id : 0;
      
      // Fetch messages from Telegram
      const messages = await client.getMessages(channel, {
        limit: 100,
        offsetId: offsetId,
      });

      let syncedCount = 0;
      let mediaCount = 0;

      for (const message of messages) {
        if (message.text || message.media) {
          const messageData = {
            telegram_message_id: message.id,
            chat_id: targetChannelId,
            text: message.text || '',
            date: new Date(message.date * 1000).toISOString(),
            media: null
          };

          // Handle media if present
          if (message.media && message.media.className !== 'MessageMediaWebPage') {
            const mediaResult = await this.handleMedia(message, client);
            if (mediaResult.success) {
              messageData.media = mediaResult.mediaData;
              mediaCount++;
            }
          }

          const result = await this.saveMessage(messageData);
          if (result.success) {
            syncedCount++;
          }
        }
      }

      await client.disconnect();

      return {
        success: true,
        synced: syncedCount,
        media: mediaCount,
        message: `Successfully synced ${syncedCount} messages with ${mediaCount} media files`
      };
    } catch (error) {
      console.error('Sync error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async handleMedia(message, client) {
    try {
      let mediaData = null;
      let buffer = null;

      // Handle different media types
      if (message.photo) {
        const photo = message.photo;
        const size = photo.sizes[photo.sizes.length - 1]; // Get largest size
        
        buffer = await client.downloadMedia(message, {
          workers: 1,
        });

        mediaData = {
          type: 'photo',
          extension: 'jpg',
          size: buffer.length,
          mime_type: 'image/jpeg',
          width: size.w,
          height: size.h
        };
      } else if (message.document) {
        const document = message.document;
        
        buffer = await client.downloadMedia(message, {
          workers: 1,
        });

        const extension = document.fileName.split('.').pop() || 'bin';
        
        mediaData = {
          type: 'document',
          extension: extension,
          size: buffer.length,
          mime_type: document.mimeType || 'application/octet-stream',
          fileName: document.fileName
        };
      }

      if (buffer && mediaData) {
        // Generate unique key for R2
        const key = `media/${message.chatId}_${message.id}_${Date.now()}.${mediaData.extension}`;
        
        // Upload to R2
        await this.env.BUCKET.put(key, buffer, {
          httpMetadata: {
            contentType: mediaData.mime_type
          }
        });

        mediaData.r2_key = key;
        
        return { success: true, mediaData };
      }

      return { success: false, error: 'Unsupported media type' };
    } catch (error) {
      console.error('Media handling error:', error);
      return { success: false, error: error.message };
    }
  }

  async saveMessage(messageData) {
    try {
      // Insert message into D1 (deduplication via UNIQUE constraint)
      const result = await this.env.DB.prepare(`
        INSERT OR IGNORE INTO messages (telegram_message_id, chat_id, text, date)
        VALUES (?, ?, ?, ?)
      `).bind(
        messageData.telegram_message_id,
        messageData.chat_id,
        messageData.text,
        messageData.date
      ).run();

      if (result.changes > 0 && messageData.media) {
        // Save media metadata to D1
        await this.env.DB.prepare(`
          INSERT INTO media (message_id, r2_key, file_type, file_size, mime_type)
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          result.meta.last_row_id,
          messageData.media.r2_key,
          messageData.media.type,
          messageData.media.size,
          messageData.media.mime_type
        ).run();
      }

      return { success: true, messageId: result.meta.last_row_id };
    } catch (error) {
      console.error('Error saving message:', error);
      return { success: false, error: error.message };
    }
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

  async getTargetChannel() {
    try {
      const result = await this.env.DB.prepare(
        'SELECT value FROM kv_store WHERE key = ?'
      ).bind('target_channel_id').first();
      
      return result ? parseInt(result.value) : null;
    } catch (error) {
      console.error('Error getting target channel:', error);
      return null;
    }
  }

  async getArchivedMessages(limit = 50, offset = 0) {
    try {
      const messages = await this.env.DB.prepare(`
        SELECT m.id, m.telegram_message_id, m.text, m.date, m.created_at,
               md.r2_key, md.file_type, md.mime_type
        FROM messages m
        LEFT JOIN media md ON m.id = md.message_id
        ORDER BY m.date DESC
        LIMIT ? OFFSET ?
      `).bind(limit, offset).all();

      return {
        success: true,
        messages: messages.results || []
      };
    } catch (error) {
      console.error('Error getting archived messages:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}
