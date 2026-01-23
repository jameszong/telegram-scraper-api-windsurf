import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';

// Polyfill to allow JSON.stringify() to handle BigInts
BigInt.prototype.toJSON = function() { return this.toString(); };

/**
 * Global Helper: Safely converts any input to BigInt.
 * Handles: null, undefined, numbers, strings.
 * Defaults to 0n on failure.
 */
const toBigInt = (val) => {
  if (val === null || val === undefined || val === '') return 0n;
  try {
    return BigInt(val);
  } catch {
    return 0n;
  }
};

// REPLACEMENT for Math.max - Strictly for BigInts
const bigIntMax = (...args) => {
  return args.reduce((m, e) => toBigInt(e) > toBigInt(m) ? toBigInt(e) : toBigInt(m), 0n);
};

// REPLACEMENT for Math.min - Strictly for BigInts
const bigIntMin = (...args) => {
  if (args.length === 0) return 0n;
  return args.reduce((m, e) => {
       const val = toBigInt(e);
       const min = toBigInt(m);
       return val < min ? val : min;
  });
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
      
      // Get message range from our database to determine sync strategy
      const rangeResult = await this.env.DB.prepare(`
        SELECT 
          MIN(CAST(telegram_message_id AS INTEGER)) as earliestId,
          MAX(CAST(telegram_message_id AS INTEGER)) as latestId,
          COUNT(*) as totalCount
        FROM messages WHERE chat_id = ?
      `).bind(channelIdStr).first();

      const earliestId = toBigInt(rangeResult?.earliestId || 0);
      const latestId = toBigInt(rangeResult?.latestId || 0);
      const totalCount = rangeResult?.totalCount || 0;
      
      console.log(`Debug: Channel range - Earliest: ${earliestId}, Latest: ${latestId}, Count: ${totalCount}`);
      
      // SMART AUTO-BACKFILL STRATEGY: Phase 1 (Updates) -> Phase 2 (History)
      let messages = [];
      // Dynamic batch size: smaller for backfill to be safer
      let isBackfillMode = earliestId > 1n && totalCount < Number(latestId - earliestId + 1n);
      const limitNum = isBackfillMode ? 25 : 50; // Increased limits since we're text-only now
      
      try {
        // Phase 1: Try fetching updates from Top (Newest messages)
        console.log(`Debug: Phase 1: Fetching updates from Top (max_id: ${latestId})`);
        
        for await (const message of client.iterMessages(channelBigInt, {
          limit: limitNum,
          reverse: false,         // Fetch from Top (Newest -> Oldest)
          min_id: Number(latestId),     // Convert BigInt to Number for API
          // NO offset_id - Start from top of channel naturally
        })) {
          // Double-check to ensure API respected minId
          if (toBigInt(message.id) <= latestId) {
            console.log(`Debug: Phase 1: Stopping at message ${message.id} (Reached min_id: ${latestId})`);
            break; // Stop iterator when we hit known history
          }
          messages.push(message);
        }
        
        // Filter actual new messages (those newer than our latest)
        const newMessages = messages.filter(m => toBigInt(m.id) > latestId);
        console.log(`Debug: Phase 1: Found ${messages.length} total, ${newMessages.length} truly new messages`);
        
        // Phase 2: Auto-Switch to Backfill if no new messages
        if (newMessages.length === 0 && earliestId > 1n) {
          console.log(`Debug: Phase 1 returned 0 new messages, switching to Backfill mode`);
          console.log(`Debug: Phase 2: Starting History Backfill from ${earliestId} backwards`);
          
          // Clear messages array and fetch older history
          messages = [];
          isBackfillMode = true;
          
          for await (const message of client.iterMessages(channelBigInt, {
            limit: limitNum,
            reverse: false,        // Newest -> Oldest
            offsetId: Number(earliestId),     // Convert BigInt to Number for API
            // NO min_id - we want to go backwards into history
          })) {
            messages.push(message);
          }
          
          console.log(`Debug: Phase 2: Backfill fetched ${messages.length} historical messages`);
        } else {
          // Use the new messages we found
          messages = newMessages;
          console.log(`Debug: Phase 1: Using ${messages.length} new messages`);
        }
        
      } catch (e) {
        console.error('Sync error:', e);
        await client.disconnect();
        return { success: false, error: 'Sync error: ' + e.message };
      }

      console.log(`Debug: Iterator found ${messages.length} new messages.`);

      let syncedCount = 0;
      let mediaCount = 0;
      let maxIdInBatch = isBackfillMode ? 0n : latestId; // Track max ID based on strategy
      let oldestIdInBatch = 0n; // Track oldest ID for backfill next offset

      // Process Messages (Standard Loop) - No more stuck detection needed
      for (const message of messages) {
        // Track the maximum ID we've seen (for history tracking)
        if (isBackfillMode) {
          // For backfill: track OLDEST message (smallest ID)
          const msgId = toBigInt(message.id);
          if (oldestIdInBatch === 0n || msgId < oldestIdInBatch) {
            oldestIdInBatch = msgId;
          }
          maxIdInBatch = bigIntMax(maxIdInBatch, msgId);
        } else {
          // For forward sync: track NEWEST message (largest ID)
          maxIdInBatch = bigIntMax(maxIdInBatch, toBigInt(message.id));
        }
        
        if (message.text || message.media) {
          // Convert BigInt IDs to strings to avoid JSON serialization issues
          const messageData = {
            telegram_message_id: message.id.toString(), // Convert BigInt to string
            chat_id: channelIdStr, // CRITICAL: Use the string channelId consistently
            text: message.text || '',
            date: new Date(Number(message.date) * 1000).toISOString(),
            grouped_id: message.groupedId ? message.groupedId.toString() : null, // Add grouped_id for album support
            media_status: 'none', // Default status
            media_type: null // Default type
          };

          // Handle media status tracking (NO DOWNLOADING in sync route)
          if (message.media && message.media.className !== 'MessageMediaWebPage') {
            console.log(`Debug: Found media type ${message.media.className} for message ${message.id}, setting status to pending`);
            messageData.media_status = 'pending';
            messageData.media_type = message.media.className;
            mediaCount++; // Count media for async processing
          } else {
            messageData.media_status = 'none';
            messageData.media_type = null;
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
            date: new Date(Number(message.date) * 1000).toISOString(),
            grouped_id: null,
            media_status: 'none', // Service messages have no media
            media_type: null
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

      // Return processed messages for immediate frontend update
      const processedMessages = messages.map(msg => ({
        id: msg.id,
        telegram_message_id: msg.id.toString(),
        chat_id: String(targetChannelId),
        text: msg.text || '',
        date: new Date(Number(msg.date) * 1000).toISOString(),
        grouped_id: msg.groupedId ? msg.groupedId.toString() : null,
        media_status: msg.media ? 'pending' : 'none',
        media_type: msg.media ? msg.media.className : null,
        media_url: null // Will be populated in Phase B
      }));

      return {
        success: true,
        synced: syncedCount,
        media: mediaCount,
        hasNewMessages: messages.length > 0,  // Indicate if there are more Messages
        messages: processedMessages, // Add processed messages array
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

  async saveMessage(messageData) {
    try {
      // UPSERT message into D1 (update existing records with new media info)
      const result = await this.env.DB.prepare(`
        INSERT INTO messages (telegram_message_id, chat_id, text, date, grouped_id, media_status, media_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(telegram_message_id, chat_id) DO UPDATE SET
          text = excluded.text,
          grouped_id = excluded.grouped_id,
          date = excluded.date,
          media_status = excluded.media_status,
          media_type = excluded.media_type
      `).bind(
        messageData.telegram_message_id,
        messageData.chat_id,
        messageData.text,
        messageData.date,
        messageData.grouped_id,
        messageData.media_status,
        messageData.media_type
      ).run(); // CRITICAL: Ensure database write is fully awaited

      // Debug: Log database write with media status
      if (messageData.media_status === 'pending') {
        console.log(`Debug: Saved message ${messageData.telegram_message_id} with pending media status, type: ${messageData.media_type}`);
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

  async processMediaMessage(pendingMessage) {
    try {
      console.log(`Debug: Starting media processing for message ${pendingMessage.telegram_message_id}`);

      // Get session and target channel
      const session = await this.getSession();
      const targetChannelId = await this.getTargetChannel();

      if (!session) {
        throw new Error('No active session found');
      }

      if (!targetChannelId) {
        throw new Error('No target channel selected');
      }

      // Connect to Telegram
      const client = await this.getClient();
      await client.connect();

      // Get channel entity
      const channelBigInt = toBigInt(pendingMessage.chat_id);
      console.log(`Debug: Resolving channel entity for chat_id: ${pendingMessage.chat_id} -> ${channelBigInt}`);
      
      const channel = await client.getEntity(channelBigInt);
      console.log(`Debug: Successfully resolved channel entity`);

      // Fetch the specific message
      const messageBigInt = toBigInt(pendingMessage.telegram_message_id);
      console.log(`Debug: Fetching message ID: ${pendingMessage.telegram_message_id} -> ${messageBigInt}`);
      
      const messages = await client.getMessages(channel, {
        ids: [messageBigInt]
      });

      if (!messages || messages.length === 0) {
        throw new Error(`Message ${pendingMessage.telegram_message_id} not found`);
      }

      const message = messages[0];
      if (!message.media) {
        throw new Error(`Message ${pendingMessage.telegram_message_id} has no media`);
      }

      console.log(`Debug: Downloading media for message ${message.id}, type: ${message.media.className}`);

      // Download media with timeout
      const downloadPromise = client.downloadMedia(message, { workers: 1 });
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Download timeout - CPU limit protection')), 10000)
      );

      let buffer = await Promise.race([downloadPromise, timeoutPromise]);
      
      // CRITICAL: Verify buffer before uploading
      if (!buffer || buffer.length === 0) {
        console.error(`Debug: Downloaded empty buffer for message ${message.id}`);
        await this.env.DB.prepare(`
          UPDATE messages SET media_status = 'failed' WHERE id = ?
        `).bind(pendingMessage.id).run();
        return {
          success: false,
          error: 'Downloaded empty buffer',
          mediaKey: null
        };
      }
      
      console.log(`Debug: Successfully downloaded media (${buffer.length} bytes)`);

      // Generate R2 key
      const chatIdStr = String(targetChannelId);
      const messageIdStr = message.id.toString();
      const extension = this.getMediaExtension(message.media.className);
      const key = `media/${chatIdStr}_${messageIdStr}_${Date.now()}.${extension}`;

      console.log(`Debug: Uploading to R2: ${key}`);

      // Upload to R2 with error handling
      try {
        await this.env.BUCKET.put(key, buffer, {
          httpMetadata: {
            contentType: this.getContentType(message.media.className)
          }
        });
        console.log(`Debug: Successfully uploaded to R2: ${key}`);
      } catch (uploadError) {
        console.error(`Debug: R2 upload failed for message ${message.id}:`, uploadError);
        await this.env.DB.prepare(`
          UPDATE messages SET media_status = 'failed' WHERE id = ?
        `).bind(pendingMessage.id).run();
        return {
          success: false,
          error: 'R2 upload failed: ' + uploadError.message,
          mediaKey: null
        };
      }

      // Update database with media key and completed status
      await this.env.DB.prepare(`
        UPDATE messages SET media_key = ?, media_status = 'completed' WHERE id = ?
      `).bind(key, pendingMessage.id).run();

      // Also save to media table for compatibility
      const mediaData = {
        type: this.getMediaType(message.media.className),
        extension: extension,
        size: buffer.length,
        mime_type: this.getContentType(message.media.className),
        r2_key: key
      };

      await this.saveMediaRecord(pendingMessage.id, mediaData);

      // Free memory
      buffer = null;

      console.log(`Debug: Media processing completed for message ${pendingMessage.telegram_message_id}`);

      return {
        success: true,
        mediaKey: key,
        mediaData: mediaData
      };

    } catch (error) {
      console.error(`Error processing media for message ${pendingMessage.telegram_message_id}:`, error);
      
      // Update status to failed
      try {
        await this.env.DB.prepare(`
          UPDATE messages SET media_status = 'failed' WHERE id = ?
        `).bind(pendingMessage.id).run();
      } catch (dbError) {
        console.error('Error updating failed status:', dbError);
      }

      return {
        success: false,
        error: error.message
      };
    }
  }

  // Helper methods for media processing
  getMediaExtension(mediaClassName) {
    switch (mediaClassName) {
      case 'MessageMediaPhoto':
        return 'jpg';
      case 'MessageMediaVideo':
        return 'mp4';
      case 'MessageMediaDocument':
        return 'bin';
      default:
        return 'bin';
    }
  }

  getMediaType(mediaClassName) {
    switch (mediaClassName) {
      case 'MessageMediaPhoto':
        return 'photo';
      case 'MessageMediaVideo':
        return 'video';
      case 'MessageMediaDocument':
        return 'document';
      default:
        return 'unknown';
    }
  }

  getContentType(mediaClassName) {
    switch (mediaClassName) {
      case 'MessageMediaPhoto':
        return 'image/jpeg';
      case 'MessageMediaVideo':
        return 'video/mp4';
      case 'MessageMediaDocument':
        return 'application/octet-stream';
      default:
        return 'application/octet-stream';
    }
  }

  async saveMediaRecord(messageId, mediaData) {
    try {
      await this.env.DB.prepare(`
        INSERT INTO media (message_id, r2_key, file_type, file_size, mime_type)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        messageId,
        mediaData.r2_key,
        mediaData.type,
        mediaData.size,
        mediaData.mime_type
      ).run();

      console.log(`Debug: Saved media record for message ${messageId}`);
    } catch (error) {
      console.error('Error saving media record:', error);
      throw error;
    }
  }
}
