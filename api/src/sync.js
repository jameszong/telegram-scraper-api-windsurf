import { TelegramClient, Api } from 'telegram';
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

      console.log(`Debug: Starting sync for channel ${targetChannelId}`);

      const client = await this.getClient();
      await client.connect();

      // Get channel entity
      const channel = await client.getEntity(targetChannelId);
      
      // Get last message ID from our database to avoid duplicates
      const lastMessage = await this.env.DB.prepare(
        'SELECT telegram_message_id FROM messages WHERE chat_id = ? ORDER BY telegram_message_id DESC LIMIT 1'
      ).bind(targetChannelId).first();

      const offsetId = lastMessage ? lastMessage.telegram_message_id : 0;
      
      console.log(`Debug: Last message ID in DB: ${offsetId}, fetching from Telegram...`);
      
      // CRITICAL: Fetch only 1 message at a time to prevent CPU timeout
      // Use min_id to get messages newer than the last one we have
      console.log(`Debug: Fetching with min_id: ${offsetId}, Limit: 1`);
      const messages = await client.getMessages(channel, {
        limit: 1,  // Atomic sync - only 1 message per request
        min_id: offsetId,  // Get messages newer than this ID
        reverse: false,  // Get in chronological order (newest first)
      });

      console.log(`Debug: Got message ID: ${messages[0]?.id}, Total: ${messages.length}`);

      console.log(`Debug: Fetched ${messages.length} messages for channel ${targetChannelId}`);

      let syncedCount = 0;
      let mediaCount = 0;

      for (const message of messages) {
        if (message.text || message.media) {
          // Convert BigInt IDs to strings to avoid JSON serialization issues
          const messageData = {
            telegram_message_id: message.id.toString(), // Convert BigInt to string
            chat_id: message.chatId ? message.chatId.toString() : targetChannelId.toString(), // Convert BigInt to string
            text: message.text || '',
            date: new Date(message.date * 1000).toISOString(),
            grouped_id: message.groupedId ? message.groupedId.toString() : null, // Add grouped_id for album support
            media: null
          };

          // Handle media if present - STRICT PHOTO-ONLY FILTER
          if (message.media && message.media.className !== 'MessageMediaWebPage') {
            // CRITICAL: Only process photos, skip all documents to prevent CPU timeout
            if (message.media.className === 'MessageMediaPhoto') {
              console.log(`Debug: Processing photo media for message ${message.id}...`);
              const mediaResult = await this.handleMedia(message, client, targetChannelId);
              if (mediaResult.success) {
                messageData.media = mediaResult.mediaData;
                mediaCount++;
                console.log(`Debug: Successfully processed photo for message ${message.id}`);
              } else {
                console.log(`Debug: Failed to process photo for message ${message.id}: ${mediaResult.error}`);
              }
            } else {
              console.log(`Debug: Skipping non-photo media (Type: ${message.media.className}) for msg ${message.id} - CPU limit protection`);
              // Skip download entirely, just save text metadata
            }
          }

          const result = await this.saveMessage(messageData);
          if (result.success) {
            syncedCount++;
          }
        }
      }

      await client.disconnect();

      console.log(`Debug: Successfully synced ${syncedCount} messages with ${mediaCount} media files`);

      return {
        success: true,
        synced: syncedCount,
        media: mediaCount,
        hasNewMessages: messages.length > 0,  // Indicate if there are more messages
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

  async handleMedia(message, client, targetChannelId) {
    try {
      let mediaData = null;
      let buffer = null;

      console.log(`Debug: Media type: ${message.media.className}`);

      // CRITICAL: Only process photos to prevent CPU timeout
      if (!message.photo) {
        console.log(`Debug: Skipping non-photo media for message ${message.id} - CPU limit protection`);
        return { success: false, error: 'Only photos are supported' };
      }

      console.log(`Debug: Downloading photo for message ${message.id}...`);
      const photo = message.photo;
      const size = photo.sizes[photo.sizes.length - 1]; // Get largest size
      
      // CRITICAL: Add 5-second timeout to prevent Worker CPU limit exceeded
      const downloadPromise = client.downloadMedia(message, { workers: 1 });
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Download timeout - CPU limit protection')), 5000)
      );

      try {
        buffer = await Promise.race([downloadPromise, timeoutPromise]);
        console.log(`Debug: Successfully downloaded photo (${buffer.length} bytes) for message ${message.id}`);
      } catch (downloadError) {
        console.error(`Error downloading photo for message ${message.id}:`, downloadError.message);
        return { success: false, error: downloadError.message };
      }

      mediaData = {
        type: 'photo',
        extension: 'jpg',
        size: buffer.length,
        mime_type: 'image/jpeg',
        width: size.w,
        height: size.h
      };

      if (buffer && mediaData) {
        // Generate unique key for R2
        const chatIdStr = message.chatId ? message.chatId.toString() : targetChannelId.toString();
        const messageIdStr = message.id.toString();
        const key = `media/${chatIdStr}_${messageIdStr}_${Date.now()}.${mediaData.extension}`;
        
        console.log(`Debug: Uploading to R2: ${key} (${buffer.length} bytes)`);
        
        // Upload to R2
        await this.env.BUCKET.put(key, buffer, {
          httpMetadata: {
            contentType: mediaData.mime_type
          }
        });

        mediaData.r2_key = key;
        console.log(`Debug: Successfully uploaded to R2: ${key}`);
        
        return { success: true, mediaData };
      }

      return { success: false, error: 'No buffer or media data' };
    } catch (error) {
      console.error(`Error processing media for message ${message.id}:`, error);
      return { success: false, error: error.message };
    }
  }

  async saveMessage(messageData) {
    try {
      // Insert message into D1 (deduplication via UNIQUE constraint)
      const result = await this.env.DB.prepare(`
        INSERT OR IGNORE INTO messages (telegram_message_id, chat_id, text, date, grouped_id)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        messageData.telegram_message_id,
        messageData.chat_id,
        messageData.text,
        messageData.date,
        messageData.grouped_id
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
        SELECT m.id, m.telegram_message_id, m.text, m.date, m.created_at, m.grouped_id,
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
