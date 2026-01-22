import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';

/**
 * Global Helper: Safely converts any input to BigInt.
 * Handles: null, undefined, numbers, strings.
 * Defaults to 0n on failure.
 */
const toBigInt = (val) => {
  if (val === null || val === undefined) return 0n;
  try {
    return BigInt(val);
  } catch {
    return 0n;
  }
};

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

      // CRITICAL: Ensure channelId is string and log type for debugging
      const channelIdStr = String(targetChannelId);
      console.log(`Debug: Starting sync for channel ${channelIdStr} (Type: ${typeof channelIdStr})`);

      const client = await this.getClient();
      await client.connect();

      // Get channel entity - CRITICAL: Use BigInt for GramJS
      const channelBigInt = toBigInt(channelIdStr);
      const channel = await client.getEntity(channelBigInt);
      
      // Get last message ID from our database to avoid duplicates
      const lastMessage = await this.env.DB.prepare(
        'SELECT MAX(CAST(telegram_message_id AS INTEGER)) as telegram_message_id FROM messages WHERE chat_id = ?'
      ).bind(channelIdStr).first();

      const rawLastId = lastMessage ? lastMessage.telegram_message_id : 0;
      const lastIdBigInt = toBigInt(rawLastId); // Returns 0n if DB is empty
      
      console.log(`Debug: Syncing ${channelBigInt} starting from ID ${lastIdBigInt}`);

      // Use GramJS Iterator (The Mature Framework Approach)
      const messages = [];
      try {
        for await (const message of client.iterMessages(channelBigInt, {
          limit: 5,              // Fetch small batches
          minId: lastIdBigInt,   // Iterator handles the "newer than" logic reliably
          reverse: true,         // Iterate chronologically (Oldest -> Newest)
        })) {
          // Double-check to ensure API respected minId
          if (toBigInt(message.id) <= lastIdBigInt) {
            console.log(`Debug: Skipping old message ${message.id} (Expected > ${lastIdBigInt})`);
            continue; 
          }
          messages.push(message);
        }
      } catch (e) {
        console.error("GramJS Iterator Error:", e);
        await client.disconnect();
        return { success: false, error: 'Iterator error: ' + e.message };
      }

      console.log(`Debug: Iterator found ${messages.length} new messages.`);

      let syncedCount = 0;
      let mediaCount = 0;

      // Process Messages (Standard Loop) - No more stuck detection needed
      for (const message of messages) {
        if (message.text || message.media) {
          // Convert BigInt IDs to strings to avoid JSON serialization issues
          const messageData = {
            telegram_message_id: message.id.toString(), // Convert BigInt to string
            chat_id: channelIdStr, // CRITICAL: Use the string channelId consistently
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
        } else {
          // CRITICAL: Save service messages as placeholders to ensure forward progress
          console.log(`Debug: Saving service message ${message.id} as placeholder to prevent infinite loop`);
          const placeholderData = {
            telegram_message_id: message.id.toString(),
            chat_id: channelIdStr, // CRITICAL: Use the consistent string channelId
            text: '[Service Message]',
            date: new Date(message.date * 1000).toISOString(),
            grouped_id: null,
            media: null
          };
          
          const result = await this.saveMessage(placeholderData);
          if (result.success) {
            syncedCount++;
            console.log(`Debug: Successfully saved placeholder for service message ${message.id}`);
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

        // CRITICAL: Free memory immediately after upload
        buffer = null;

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
      // UPSERT message into D1 (update existing records with new media info)
      const result = await this.env.DB.prepare(`
        INSERT INTO messages (telegram_message_id, chat_id, text, date, grouped_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(telegram_message_id, chat_id) DO UPDATE SET
          text = excluded.text,
          grouped_id = excluded.grouped_id,
          date = excluded.date
      `).bind(
        messageData.telegram_message_id,
        messageData.chat_id,
        messageData.text,
        messageData.date,
        messageData.grouped_id
      ).run();

      // Debug: Log database write
      if (messageData.media) {
        console.log(`Debug: Updating DB for msg ${messageData.telegram_message_id} with media key: ${messageData.media.r2_key}`);
      }

      // For UPSERT, we need to get the message ID regardless of whether it was inserted or updated
      let messageId;
      if (result.changes > 0) {
        // New message inserted
        messageId = result.meta.last_row_id;
      } else {
        // Existing message updated - get its ID
        const existingMessage = await this.env.DB.prepare(`
          SELECT id FROM messages 
          WHERE telegram_message_id = ? AND chat_id = ?
        `).bind(
          messageData.telegram_message_id,
          messageData.chat_id
        ).first();
        messageId = existingMessage.id;
      }

      if (messageId && messageData.media) {
        // Check if media already exists for this message
        const existingMedia = await this.env.DB.prepare(`
          SELECT id FROM media WHERE message_id = ?
        `).bind(messageId).first();

        if (!existingMedia) {
          // Save media metadata to D1
          await this.env.DB.prepare(`
            INSERT INTO media (message_id, r2_key, file_type, file_size, mime_type)
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            messageId,
            messageData.media.r2_key,
            messageData.media.type,
            messageData.media.size,
            messageData.media.mime_type
          ).run();
          console.log(`Debug: Inserted new media record for message ${messageId}`);
        } else {
          // Update existing media record
          await this.env.DB.prepare(`
            UPDATE media SET r2_key = ?, file_type = ?, file_size = ?, mime_type = ?
            WHERE message_id = ?
          `).bind(
            messageData.media.r2_key,
            messageData.media.type,
            messageData.media.size,
            messageData.media.mime_type,
            messageId
          ).run();
          console.log(`Debug: Updated existing media record for message ${messageId}`);
        }
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
      
      // CRITICAL: Ensure channelId is always a string to match DB column type
      return result ? String(result.value) : null;
    } catch (error) {
      console.error('Error getting target channel:', error);
      return null;
    }
  }

  async getArchivedMessages(channelId, limit = 50, offset = 0) {
    try {
      const messages = await this.env.DB.prepare(`
        SELECT m.id, m.telegram_message_id, m.text, m.date, m.created_at, m.grouped_id,
               md.r2_key, md.file_type, md.mime_type
        FROM messages m
        LEFT JOIN media md ON m.id = md.message_id
        WHERE m.chat_id = ?
        ORDER BY m.date DESC
        LIMIT ? OFFSET ?
      `).bind(channelId, limit, offset).all();

      return {
        success: true,
        messages: messages.results || []
      };
    } catch (error) {
      console.error('Error getting archived messages:', error);
      return {
        success: false,
        error: error.message,
        messages: []
      };
    }
  }
}
